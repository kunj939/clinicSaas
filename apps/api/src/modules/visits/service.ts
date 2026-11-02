import type { AppContext } from '../../context.js';
import type { AuthContext } from '../../auth/session.js';
import { assertDoctorScope } from '../../auth/guards.js';
import { withTransaction, type Db, type Pool } from '../../db/pool.js';
import { addDays, dateInTimeZone, formatDisplayDate, periodOf } from '../../lib/clinic-time.js';
import { AppError, errors } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { getClinicById, type ClinicRow } from '../clinic/service.js';
import { enqueueMessage, type EnqueueResult } from '../messaging/outbox.js';
import { render } from '../messaging/templates.js';
import { getTokenForUpdate } from '../tokens/service.js';
import { doctorNameFor } from '../tokens/booking.js';
import type { Lang } from '../messaging/templates.js';

type Scoped = AuthContext & { clinicId: string };

export interface VisitInput {
  diagnosis?: string | null;
  clinicalNotes?: string | null;
  prescription?: string | null;
  /** How long the prescribed medicine lasts. Sets the follow-up date when no date is given. */
  medicineDays?: number | null;
  followUpDate?: string | null;
}

/** Methods staff can record by hand. */
export const MANUAL_PAYMENT_METHODS = ['cash', 'upi', 'card', 'other'] as const;
/** Every method a visit can end up with. 'online' is set only when a PayU payment succeeds. */
export const PAYMENT_METHODS = [...MANUAL_PAYMENT_METHODS, 'online'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface PaymentInput {
  feeAmount: number | null;
  amountPaid: number | null;
  paymentMethod: PaymentMethod | null;
}

export interface VisitDto {
  id: string;
  tokenId: string;
  patientId: string;
  doctorId: string;
  visitDate: string;
  diagnosis: string | null;
  clinicalNotes: string | null;
  prescription: string | null;
  medicineDays: number | null;
  followUpDate: string | null;
  feeAmount: number | null;
  amountPaid: number | null;
  paymentMethod: PaymentMethod | null;
  updatedAt: string;
}

function toVisitDto(row: Record<string, unknown>): VisitDto {
  return {
    id: row.id as string,
    tokenId: row.token_id as string,
    patientId: row.patient_id as string,
    doctorId: row.doctor_id as string,
    visitDate: row.visit_date as string,
    diagnosis: row.diagnosis as string | null,
    clinicalNotes: row.clinical_notes as string | null,
    prescription: row.prescription as string | null,
    medicineDays: row.medicine_days as number | null,
    followUpDate: row.follow_up_date as string | null,
    feeAmount: row.fee_amount as number | null,
    amountPaid: row.amount_paid as number | null,
    paymentMethod: row.payment_method as PaymentMethod | null,
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

/**
 * Follow-up date for a medicine course: the day before the medicine runs out, minus the clinic's
 * lead time. A one-day course still gets a reminder the next day.
 */
export function followUpForMedicine(visitDate: string, medicineDays: number, leadDays: number): string {
  return addDays(visitDate, Math.max(1, medicineDays - leadDays));
}

export async function getVisitForToken(db: Db, auth: Scoped, tokenId: string): Promise<VisitDto | null> {
  const { rows: tokenRows } = await db.query<{ doctor_id: string }>(
    'SELECT doctor_id FROM tokens WHERE id = $1 AND clinic_id = $2',
    [tokenId, auth.clinicId],
  );
  if (!tokenRows[0]) throw errors.notFound('Token');
  assertDoctorScope(auth, tokenRows[0].doctor_id);
  const { rows } = await db.query('SELECT * FROM visits WHERE token_id = $1 AND clinic_id = $2', [tokenId, auth.clinicId]);
  return rows[0] ? toVisitDto(rows[0]) : null;
}

/** Creates or updates the consultation note. A follow-up date also creates an open follow-up. */
export async function saveVisit(pool: Pool, auth: Scoped, tokenId: string, input: VisitInput): Promise<VisitDto> {
  return withTransaction(pool, async (client) => {
    const token = await getTokenForUpdate(client, auth.clinicId, tokenId);
    assertDoctorScope(auth, token.doctor_id);
    if (token.status !== 'in_consultation' && token.status !== 'completed') {
      throw new AppError(409, 'invalid_transition', 'Notes can be written during or after the consultation');
    }

    // An explicit date wins. Otherwise a medicine course sets the date.
    const { rows: clinicRows } = await client.query<{ follow_up_lead_days: number }>(
      'SELECT follow_up_lead_days FROM clinics WHERE id = $1',
      [auth.clinicId],
    );
    const followUpDate =
      input.followUpDate ??
      (input.medicineDays ? followUpForMedicine(token.service_date, input.medicineDays, clinicRows[0]?.follow_up_lead_days ?? 1) : null);

    const { rows } = await client.query(
      `INSERT INTO visits (clinic_id, token_id, patient_id, doctor_id, visit_date, diagnosis, clinical_notes, prescription, medicine_days, follow_up_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (token_id) DO UPDATE SET
         diagnosis = EXCLUDED.diagnosis,
         clinical_notes = EXCLUDED.clinical_notes,
         prescription = EXCLUDED.prescription,
         medicine_days = EXCLUDED.medicine_days,
         follow_up_date = EXCLUDED.follow_up_date,
         updated_at = now()
       RETURNING *`,
      [
        auth.clinicId,
        tokenId,
        token.patient_id,
        token.doctor_id,
        token.service_date,
        input.diagnosis ?? null,
        input.clinicalNotes ?? null,
        input.prescription ?? null,
        input.medicineDays ?? null,
        followUpDate,
      ],
    );
    const visit = rows[0];

    if (followUpDate) {
      const updated = await client.query(
        `UPDATE follow_ups SET due_date = $2
          WHERE visit_id = $1 AND status = 'open' RETURNING id`,
        [visit.id, followUpDate],
      );
      if (!updated.rowCount) {
        await client.query(
          `INSERT INTO follow_ups (clinic_id, patient_id, doctor_id, visit_id, due_date, reason, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, 'Follow-up from consultation', $6)`,
          [auth.clinicId, token.patient_id, token.doctor_id, visit.id, followUpDate, auth.userId],
        );
      }
    } else {
      await client.query(
        `UPDATE follow_ups SET status = 'cancelled', completed_at = now()
          WHERE visit_id = $1 AND status = 'open'`,
        [visit.id],
      );
    }

    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'visit.saved',
      entityType: 'visit',
      entityId: visit.id,
      metadata: { hasFollowUp: Boolean(followUpDate) },
    });
    return toVisitDto(visit);
  });
}

/**
 * Records fee and payment for a consultation. Reception collects after the visit, so this works
 * from the moment the patient is with the doctor until the token is completed.
 */
export async function recordPayment(pool: Pool, auth: Scoped, tokenId: string, input: PaymentInput): Promise<VisitDto> {
  return withTransaction(pool, async (client) => {
    const visit = await ensureVisit(client, auth, tokenId);
    const { rows } = await client.query(
      `UPDATE visits SET fee_amount = $2, amount_paid = $3, payment_method = $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [visit.id, input.feeAmount, input.amountPaid, input.paymentMethod],
    );
    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'payment.recorded',
      entityType: 'visit',
      entityId: visit.id,
      metadata: { method: input.paymentMethod ?? 'none' },
    });
    return toVisitDto(rows[0]);
  });
}

/** Makes sure a visit row exists for the token (reports attach to visits). */
export async function ensureVisit(client: Db, auth: Scoped, tokenId: string): Promise<{ id: string; patientId: string; doctorId: string }> {
  const token = await getTokenForUpdate(client, auth.clinicId, tokenId);
  assertDoctorScope(auth, token.doctor_id);
  if (token.status === 'booked' || token.status === 'checked_in' || token.status === 'cancelled') {
    throw new AppError(409, 'invalid_transition', 'Reports can be attached once the patient has been seen');
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO visits (clinic_id, token_id, patient_id, doctor_id, visit_date)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token_id) DO UPDATE SET updated_at = visits.updated_at
     RETURNING id`,
    [auth.clinicId, tokenId, token.patient_id, token.doctor_id, token.service_date],
  );
  return { id: rows[0]!.id, patientId: token.patient_id, doctorId: token.doctor_id };
}

export interface FollowUpDto {
  id: string;
  patientId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  dueDate: string;
  reason: string | null;
  status: string;
  lastReminderAt: string | null;
}

export async function listFollowUps(
  db: Db,
  auth: Scoped,
  options: { status: 'open' | 'done' | 'cancelled' | 'all'; doctorId?: string; dueBefore?: string },
): Promise<FollowUpDto[]> {
  const doctorFilter = auth.role === 'doctor' ? auth.doctorId : (options.doctorId ?? null);
  const { rows } = await db.query(
    `SELECT f.id, f.patient_id, p.full_name, f.doctor_id, d.name AS doctor_name, f.due_date, f.reason, f.status, f.last_reminder_at
       FROM follow_ups f
       JOIN patients p ON p.id = f.patient_id
       JOIN doctors d ON d.id = f.doctor_id
      WHERE f.clinic_id = $1
        AND ($2::text = 'all' OR f.status = $2)
        AND ($3::uuid IS NULL OR f.doctor_id = $3)
        AND ($4::date IS NULL OR f.due_date <= $4)
      ORDER BY f.due_date, f.created_at
      LIMIT 200`,
    [auth.clinicId, options.status, doctorFilter, options.dueBefore ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    patientId: row.patient_id,
    patientName: row.full_name,
    doctorId: row.doctor_id,
    doctorName: row.doctor_name,
    dueDate: row.due_date,
    reason: row.reason,
    status: row.status,
    lastReminderAt: row.last_reminder_at?.toISOString() ?? null,
  }));
}

export async function createFollowUp(
  pool: Pool,
  auth: Scoped,
  input: { patientId: string; doctorId: string; dueDate: string; reason?: string | null },
): Promise<string> {
  assertDoctorScope(auth, input.doctorId);
  return withTransaction(pool, async (client) => {
    const { rowCount } = await client.query('SELECT 1 FROM patients WHERE id = $1 AND clinic_id = $2', [
      input.patientId,
      auth.clinicId,
    ]);
    if (!rowCount) throw errors.notFound('Patient');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO follow_ups (clinic_id, patient_id, doctor_id, due_date, reason, created_by_user_id)
       SELECT $1, $2, d.id, $4, $5, $6 FROM doctors d WHERE d.id = $3 AND d.clinic_id = $1
       RETURNING id`,
      [auth.clinicId, input.patientId, input.doctorId, input.dueDate, input.reason ?? null, auth.userId],
    );
    if (!rows[0]) throw errors.notFound('Doctor');
    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'follow_up.created',
      entityType: 'follow_up',
      entityId: rows[0].id,
    });
    return rows[0].id;
  });
}

export async function markFollowUpDone(pool: Pool, auth: Scoped, id: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ doctor_id: string; status: string }>(
      'SELECT doctor_id, status FROM follow_ups WHERE id = $1 AND clinic_id = $2 FOR UPDATE',
      [id, auth.clinicId],
    );
    if (!rows[0]) throw errors.notFound('Follow-up');
    assertDoctorScope(auth, rows[0].doctor_id);
    if (rows[0].status !== 'open') throw new AppError(409, 'invalid_transition', 'Follow-up is not open');
    await client.query(`UPDATE follow_ups SET status = 'done', completed_at = now() WHERE id = $1`, [id]);
    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'follow_up.done',
      entityType: 'follow_up',
      entityId: id,
    });
  });
}

/** Sends a follow-up reminder. Once per follow-up per due date, so repeated clicks do not spam patients. */
export async function sendFollowUpReminder(ctx: AppContext, auth: Scoped, id: string): Promise<EnqueueResult | 'no_phone'> {
  const clinic = await getClinicById(ctx.pool, auth.clinicId);
  if (!clinic) throw errors.notFound('Clinic');
  return withTransaction(ctx.pool, (client) =>
    queueFollowUpReminder(client, ctx, clinic, id, (doctorId) => assertDoctorScope(auth, doctorId)),
  );
}

/**
 * Queues the reminder for open follow-ups due today, in each clinic's own timezone. Runs hourly from
 * the worker. The dedupe key keeps it to one reminder per follow-up per due date.
 */
export async function sendDueFollowUpReminders(ctx: AppContext): Promise<number> {
  const { rows } = await ctx.pool.query<{ id: string; clinic_id: string }>(
    `SELECT f.id, f.clinic_id
       FROM follow_ups f JOIN clinics c ON c.id = f.clinic_id
      WHERE f.status = 'open' AND f.last_reminder_at IS NULL
        AND f.due_date = ($1::timestamptz AT TIME ZONE c.timezone)::date
      ORDER BY f.due_date
      LIMIT 200`,
    [ctx.now()],
  );
  let queued = 0;
  for (const row of rows) {
    const clinic = await getClinicById(ctx.pool, row.clinic_id);
    if (!clinic) continue;
    try {
      const outcome = await withTransaction(ctx.pool, (client) => queueFollowUpReminder(client, ctx, clinic, row.id, () => undefined));
      if (outcome === 'queued') queued += 1;
    } catch (error) {
      // A follow-up closed between the query and the lock is simply skipped.
      if (!(error instanceof AppError && error.statusCode === 409)) throw error;
    }
  }
  return queued;
}

async function queueFollowUpReminder(
  client: Db,
  ctx: AppContext,
  clinic: ClinicRow,
  id: string,
  checkScope: (doctorId: string) => void,
): Promise<EnqueueResult | 'no_phone'> {
  const { rows } = await client.query<{
    id: string;
    doctor_id: string;
    due_date: string;
    status: string;
    phone_encrypted: string | null;
    preferred_language: Lang;
  }>(
    `SELECT f.id, f.doctor_id, f.due_date, f.status, p.phone_encrypted, p.preferred_language
       FROM follow_ups f JOIN patients p ON p.id = f.patient_id
      WHERE f.id = $1 AND f.clinic_id = $2 FOR UPDATE OF f`,
    [id, clinic.id],
  );
  const followUp = rows[0];
  if (!followUp) throw errors.notFound('Follow-up');
  checkScope(followUp.doctor_id);
  if (followUp.status !== 'open') throw new AppError(409, 'invalid_transition', 'Follow-up is not open');
  if (!followUp.phone_encrypted) return 'no_phone';

  const outcome = await enqueueMessage(client, ctx.cipher, {
    clinicId: clinic.id,
    kind: 'notification',
    templateKey: 'follow_up_reminder',
    phone: ctx.cipher.decrypt(followUp.phone_encrypted),
    text: render(followUp.preferred_language, 'notif.follow_up', {
      clinic: clinic.name,
      doctor: await doctorNameFor(client, followUp.doctor_id),
      date: formatDisplayDate(followUp.due_date),
    }),
    dedupeKey: `followup:${followUp.id}:${followUp.due_date}`,
    period: periodOf(dateInTimeZone(ctx.now(), clinic.timezone)),
    quota: clinic.monthly_message_quota,
  });
  if (outcome === 'queued') {
    await client.query('UPDATE follow_ups SET last_reminder_at = now() WHERE id = $1', [id]);
  }
  return outcome;
}

