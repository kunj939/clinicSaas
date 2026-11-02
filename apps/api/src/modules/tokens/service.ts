import type { Db, Pool } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import type { AuthContext } from '../../auth/session.js';
import { assertDoctorScope } from '../../auth/guards.js';
import type { FieldCipher } from '../../lib/crypto.js';
import { weekdayOf } from '../../lib/clinic-time.js';
import { AppError, errors, isPgError, PG_UNIQUE_VIOLATION } from '../../lib/errors.js';
import { maskPhone } from '../../lib/phone.js';
import { recordAudit } from '../audit/service.js';

export type TokenSource = 'whatsapp' | 'phone' | 'walk_in';
export type TokenStatus = 'booked' | 'checked_in' | 'in_consultation' | 'completed' | 'no_show' | 'cancelled';

export interface TokenRow {
  id: string;
  day_id: string;
  doctor_id: string;
  patient_id: string;
  service_date: string;
  token_number: number;
  source: TokenSource;
  status: TokenStatus;
  checked_in_at: Date | null;
  called_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
}

export function toTokenDto(row: TokenRow) {
  return {
    id: row.id,
    doctorId: row.doctor_id,
    patientId: row.patient_id,
    date: row.service_date,
    tokenNumber: row.token_number,
    source: row.source,
    status: row.status,
    checkedInAt: row.checked_in_at?.toISOString() ?? null,
    calledAt: row.called_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export interface AllocateInput {
  clinicId: string;
  doctorId: string;
  patientId: string;
  date: string;
  source: TokenSource;
  createdByUserId: string | null;
  checkIn: boolean;
}

/**
 * Hands out the next serial token. Runs inside the caller's transaction.
 *
 * Concurrency: the single UPDATE on appointment_days takes a row lock and only succeeds while
 * active_count < capacity, so two bookings can never receive the same number or exceed capacity.
 * A duplicate booking for the same patient is blocked by a partial unique index and rolls back
 * the counter increment together with the failed insert.
 */
export async function allocateToken(client: Db, input: AllocateInput): Promise<TokenRow> {
  const { rows: patientRows } = await client.query('SELECT 1 FROM patients WHERE id = $1 AND clinic_id = $2', [
    input.patientId,
    input.clinicId,
  ]);
  if (!patientRows.length) throw errors.notFound('Patient');

  const { rows: scheduleRows } = await client.query<{ max_tokens: number; is_active: boolean; doctor_active: boolean }>(
    `SELECT s.max_tokens, s.is_active, d.is_active AS doctor_active
       FROM doctors d
       LEFT JOIN doctor_schedules s ON s.doctor_id = d.id AND s.weekday = $3
      WHERE d.id = $1 AND d.clinic_id = $2`,
    [input.doctorId, input.clinicId, weekdayOf(input.date)],
  );
  const schedule = scheduleRows[0];
  if (!schedule) throw errors.notFound('Doctor');
  if (!schedule.doctor_active || !schedule.is_active || schedule.max_tokens === null) {
    throw new AppError(409, 'doctor_not_available', 'The doctor is not available on this date');
  }

  const { rowCount: holidayCount } = await client.query(
    'SELECT 1 FROM clinic_holidays WHERE clinic_id = $1 AND holiday_date = $2',
    [input.clinicId, input.date],
  );
  if (holidayCount) throw new AppError(409, 'clinic_closed', 'The clinic is closed on this date');

  await client.query(
    `INSERT INTO appointment_days (clinic_id, doctor_id, service_date, capacity)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (doctor_id, service_date) DO NOTHING`,
    [input.clinicId, input.doctorId, input.date, schedule.max_tokens],
  );

  const allocated = await client.query<{ id: string; last_token_number: number }>(
    `UPDATE appointment_days
        SET last_token_number = last_token_number + 1,
            active_count = active_count + 1
      WHERE clinic_id = $1 AND doctor_id = $2 AND service_date = $3 AND active_count < capacity
      RETURNING id, last_token_number`,
    [input.clinicId, input.doctorId, input.date],
  );
  const day = allocated.rows[0];
  if (!day) throw new AppError(409, 'fully_booked', 'All tokens for this doctor are taken for the date');

  try {
    const { rows } = await client.query<TokenRow>(
      `INSERT INTO tokens (clinic_id, day_id, doctor_id, patient_id, service_date, token_number, source, status,
                           checked_in_at, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9::boolean THEN now() END, $10)
       RETURNING *`,
      [
        input.clinicId,
        day.id,
        input.doctorId,
        input.patientId,
        input.date,
        day.last_token_number,
        input.source,
        input.checkIn ? 'checked_in' : 'booked',
        input.checkIn,
        input.createdByUserId,
      ],
    );
    return rows[0]!;
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      throw new AppError(409, 'already_booked', 'This patient already has a token with this doctor on this date');
    }
    throw error;
  }
}

export async function getTokenForUpdate(client: Db, clinicId: string, tokenId: string): Promise<TokenRow> {
  const { rows } = await client.query<TokenRow>(
    'SELECT * FROM tokens WHERE id = $1 AND clinic_id = $2 FOR UPDATE',
    [tokenId, clinicId],
  );
  if (!rows[0]) throw errors.notFound('Token');
  return rows[0];
}

const RECEPTION_TRANSITIONS: Record<'check-in' | 'no-show' | 'cancel', { from: TokenStatus[]; to: TokenStatus }> = {
  'check-in': { from: ['booked'], to: 'checked_in' },
  'no-show': { from: ['booked', 'checked_in'], to: 'no_show' },
  cancel: { from: ['booked', 'checked_in'], to: 'cancelled' },
};

/** Reception actions: check-in, mark no-show, or cancel. Cancelling releases the slot for others. */
export async function applyReceptionAction(
  pool: Pool,
  auth: AuthContext & { clinicId: string },
  tokenId: string,
  action: keyof typeof RECEPTION_TRANSITIONS,
): Promise<TokenRow> {
  const transition = RECEPTION_TRANSITIONS[action];
  return withTransaction(pool, async (client) => {
    const token = await getTokenForUpdate(client, auth.clinicId, tokenId);
    if (!transition.from.includes(token.status)) {
      throw new AppError(409, 'invalid_transition', `Token is ${token.status} and cannot be ${action}`);
    }
    const { rows } = await client.query<TokenRow>(
      `UPDATE tokens SET
         status = $2,
         checked_in_at = CASE WHEN $2 = 'checked_in' THEN now() ELSE checked_in_at END,
         cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [tokenId, transition.to],
    );
    if (transition.to === 'cancelled') {
      await client.query(
        'UPDATE appointment_days SET active_count = active_count - 1 WHERE id = $1 AND active_count > 0',
        [token.day_id],
      );
    }
    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: `token.${action.replace('-', '_')}`,
      entityType: 'token',
      entityId: tokenId,
      metadata: { from: token.status, to: transition.to },
    });
    return rows[0]!;
  });
}

/** Doctor picks the next waiting patient. Only one patient can be in consultation per doctor per day. */
export async function callNextPatient(
  pool: Pool,
  auth: AuthContext & { clinicId: string },
  doctorId: string,
  date: string,
): Promise<TokenRow | null> {
  assertDoctorScope(auth, doctorId);
  return withTransaction(pool, async (client) => {
    const { rows: dayRows } = await client.query<{ id: string }>(
      `SELECT id FROM appointment_days WHERE clinic_id = $1 AND doctor_id = $2 AND service_date = $3 FOR UPDATE`,
      [auth.clinicId, doctorId, date],
    );
    const day = dayRows[0];
    if (!day) return null;

    const busy = await client.query(
      `SELECT 1 FROM tokens WHERE day_id = $1 AND status = 'in_consultation'`,
      [day.id],
    );
    if (busy.rowCount) throw new AppError(409, 'consultation_in_progress', 'Finish the current patient first');

    const { rows } = await client.query<TokenRow>(
      `UPDATE tokens SET status = 'in_consultation', called_at = now(), updated_at = now()
        WHERE id = (
          SELECT id FROM tokens
           WHERE day_id = $1 AND status = 'checked_in'
           ORDER BY token_number
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [day.id],
    );
    if (!rows[0]) return null;
    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'token.called',
      entityType: 'token',
      entityId: rows[0].id,
    });
    return rows[0];
  });
}

export async function completeToken(pool: Pool, auth: AuthContext & { clinicId: string }, tokenId: string): Promise<TokenRow> {
  return withTransaction(pool, async (client) => {
    const token = await getTokenForUpdate(client, auth.clinicId, tokenId);
    assertDoctorScope(auth, token.doctor_id);
    if (token.status !== 'in_consultation') {
      throw new AppError(409, 'invalid_transition', `Token is ${token.status}; only a patient in consultation can be completed`);
    }
    const { rows } = await client.query<TokenRow>(
      `UPDATE tokens SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [tokenId],
    );
    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'token.completed',
      entityType: 'token',
      entityId: tokenId,
    });
    return rows[0]!;
  });
}

export interface QueueItem {
  id: string;
  tokenNumber: number;
  status: TokenStatus;
  source: TokenSource;
  patientId: string;
  patientName: string;
  phoneMasked: string | null;
  visitId: string | null;
  checkedInAt: string | null;
  calledAt: string | null;
}

export async function getDoctorQueue(
  db: Db,
  cipher: FieldCipher,
  auth: AuthContext & { clinicId: string },
  doctorId: string,
  date: string,
) {
  assertDoctorScope(auth, doctorId);
  const { rows: doctorRows } = await db.query<{ id: string; name: string; is_active: boolean }>(
    'SELECT id, name, is_active FROM doctors WHERE id = $1 AND clinic_id = $2',
    [doctorId, auth.clinicId],
  );
  if (!doctorRows[0]) throw errors.notFound('Doctor');

  const { rows: dayRows } = await db.query<{ capacity: number; active_count: number; last_token_number: number }>(
    'SELECT capacity, active_count, last_token_number FROM appointment_days WHERE doctor_id = $1 AND service_date = $2',
    [doctorId, date],
  );

  const { rows } = await db.query<{
    id: string;
    token_number: number;
    status: TokenStatus;
    source: TokenSource;
    patient_id: string;
    full_name: string;
    phone_encrypted: string | null;
    visit_id: string | null;
    checked_in_at: Date | null;
    called_at: Date | null;
  }>(
    `SELECT t.id, t.token_number, t.status, t.source, t.checked_in_at, t.called_at,
            p.id AS patient_id, p.full_name, p.phone_encrypted, v.id AS visit_id
       FROM tokens t
       JOIN patients p ON p.id = t.patient_id
       LEFT JOIN visits v ON v.token_id = t.id
      WHERE t.clinic_id = $1 AND t.doctor_id = $2 AND t.service_date = $3
      ORDER BY t.token_number`,
    [auth.clinicId, doctorId, date],
  );

  const tokens: QueueItem[] = rows.map((row) => {
    const phone = row.phone_encrypted ? cipher.decrypt(row.phone_encrypted) : null;
    return {
      id: row.id,
      tokenNumber: row.token_number,
      status: row.status,
      source: row.source,
      patientId: row.patient_id,
      patientName: row.full_name,
      phoneMasked: phone ? maskPhone(phone) : null,
      visitId: row.visit_id,
      checkedInAt: row.checked_in_at?.toISOString() ?? null,
      calledAt: row.called_at?.toISOString() ?? null,
    };
  });

  const day = dayRows[0];
  return {
    date,
    doctor: { id: doctorRows[0].id, name: doctorRows[0].name, isActive: doctorRows[0].is_active },
    capacity: day?.capacity ?? 0,
    activeCount: day?.active_count ?? 0,
    lastTokenNumber: day?.last_token_number ?? 0,
    tokens,
  };
}

export async function getQueueSummary(db: Db, clinicId: string, date: string) {
  const { rows } = await db.query<{
    doctor_id: string;
    name: string;
    capacity: number;
    active_count: number;
    waiting: number;
    in_consultation: number;
    completed: number;
    no_show: number;
  }>(
    `SELECT d.id AS doctor_id, d.name,
            COALESCE(ad.capacity, 0) AS capacity,
            COALESCE(ad.active_count, 0) AS active_count,
            COUNT(t.id) FILTER (WHERE t.status IN ('booked', 'checked_in'))::int AS waiting,
            COUNT(t.id) FILTER (WHERE t.status = 'in_consultation')::int AS in_consultation,
            COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS completed,
            COUNT(t.id) FILTER (WHERE t.status = 'no_show')::int AS no_show
       FROM doctors d
       LEFT JOIN appointment_days ad ON ad.doctor_id = d.id AND ad.service_date = $2
       LEFT JOIN tokens t ON t.day_id = ad.id
      WHERE d.clinic_id = $1 AND d.is_active
      GROUP BY d.id, d.name, ad.capacity, ad.active_count
      ORDER BY d.name`,
    [clinicId, date],
  );
  return rows.map((row) => ({
    doctorId: row.doctor_id,
    doctorName: row.name,
    capacity: row.capacity,
    activeCount: row.active_count,
    waiting: row.waiting,
    inConsultation: row.in_consultation,
    completed: row.completed,
    noShow: row.no_show,
  }));
}

