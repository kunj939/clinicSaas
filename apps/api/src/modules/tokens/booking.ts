import type { AppContext } from '../../context.js';
import type { AuthContext } from '../../auth/session.js';
import { withTransaction, type Db } from '../../db/pool.js';
import { dateInTimeZone, formatDisplayDate, periodOf } from '../../lib/clinic-time.js';
import { AppError, errors } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';
import { recordAudit } from '../audit/service.js';
import { getClinicById, type ClinicRow } from '../clinic/service.js';
import { enqueueMessage, type EnqueueResult } from '../messaging/outbox.js';
import { render } from '../messaging/templates.js';
import { findOrCreatePatientByPhone, getPatient, type PatientRow } from '../patients/service.js';
import { allocateToken, toTokenDto, type TokenSource } from './service.js';
import { getAvailability } from './availability.js';

export type PatientRef =
  | { patientId: string }
  | { fullName: string; phone: string; gender?: 'male' | 'female' | 'other' | null; ageYears?: number | null };

export interface StaffBookingInput {
  doctorId: string;
  date: string;
  source: Exclude<TokenSource, 'whatsapp'>;
  patient: PatientRef;
  notifyPatient: boolean;
}

export type NotificationOutcome = EnqueueResult | 'no_phone' | 'disabled' | 'skipped';

export function clinicToday(clinic: ClinicRow, now: Date): string {
  return dateInTimeZone(now, clinic.timezone);
}

/** Books a token on behalf of reception or the owner. Walk-ins are checked in immediately. */
export async function bookTokenForStaff(ctx: AppContext, auth: AuthContext & { clinicId: string }, input: StaffBookingInput) {
  const clinic = await getClinicById(ctx.pool, auth.clinicId);
  if (!clinic) throw errors.notFound('Clinic');
  const today = clinicToday(clinic, ctx.now());
  if (input.date < today) throw new AppError(400, 'past_date', 'Tokens cannot be booked for a past date');

  return withTransaction(ctx.pool, async (client) => {
    const patient = await resolvePatient(client, ctx, auth.clinicId, input.patient);
    const token = await allocateToken(client, {
      clinicId: auth.clinicId,
      doctorId: input.doctorId,
      patientId: patient.id,
      date: input.date,
      source: input.source,
      createdByUserId: auth.userId,
      checkIn: input.source === 'walk_in',
    });

    let notification: NotificationOutcome = 'skipped';
    if (input.source !== 'walk_in') {
      notification = input.notifyPatient
        ? await queueTokenConfirmation(client, ctx, clinic, patient, token.id, input.doctorId, input.date, token.token_number)
        : 'disabled';
    }

    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'token.booked',
      entityType: 'token',
      entityId: token.id,
      metadata: { source: input.source, notification },
    });
    return { token: toTokenDto(token), patientId: patient.id, notification };
  });
}

async function resolvePatient(client: Db, ctx: AppContext, clinicId: string, ref: PatientRef): Promise<PatientRow> {
  if ('patientId' in ref) return getPatient(client, clinicId, ref.patientId);

  const phone = normalizePhone(ref.phone, ctx.config.defaultCountryCode);
  if (!phone) throw errors.validation('Enter a valid phone number');
  return findOrCreatePatientByPhone(client, ctx.cipher, clinicId, {
    fullName: ref.fullName,
    phone,
    gender: ref.gender ?? null,
    ageYears: ref.ageYears ?? null,
  });
}

/** Queues the patient-facing confirmation. Notifications count against the monthly quota. */
export async function queueTokenConfirmation(
  client: Db,
  ctx: AppContext,
  clinic: ClinicRow,
  patient: PatientRow,
  tokenId: string,
  doctorId: string,
  date: string,
  tokenNumber: number,
): Promise<NotificationOutcome> {
  if (!patient.phone_encrypted) return 'no_phone';
  const doctorName = await doctorNameFor(client, doctorId);
  const phone = ctx.cipher.decrypt(patient.phone_encrypted);
  return enqueueMessage(client, ctx.cipher, {
    clinicId: clinic.id,
    kind: 'notification',
    templateKey: 'token_confirmed',
    phone,
    text: render(patient.preferred_language, 'notif.token_confirmed', {
      clinic: clinic.name,
      token: tokenNumber,
      doctor: doctorName,
      date: formatDisplayDate(date),
    }),
    dedupeKey: `token:${tokenId}:confirmed`,
    period: periodOf(dateInTimeZone(ctx.now(), clinic.timezone)),
    quota: clinic.monthly_message_quota,
  });
}

export async function doctorNameFor(db: Db, doctorId: string): Promise<string> {
  const { rows } = await db.query<{ name: string }>('SELECT name FROM doctors WHERE id = $1', [doctorId]);
  return rows[0]?.name ?? '';
}

/** Availability for a doctor on a date, judged against the clinic's own "today". */
export async function availabilityForClinic(ctx: AppContext, clinicId: string, doctorId: string, date: string) {
  const clinic = await getClinicById(ctx.pool, clinicId);
  if (!clinic) throw errors.notFound('Clinic');
  return getAvailability(ctx.pool, { clinicId, doctorId, date, today: clinicToday(clinic, ctx.now()) });
}
