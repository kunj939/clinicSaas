import { randomBytes } from 'node:crypto';
import type { Db, Pool } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import type { AuthContext } from '../../auth/session.js';
import { errors, isPgError, PG_UNIQUE_VIOLATION, AppError } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { dateInTimeZone, periodOf } from '../../lib/clinic-time.js';
import type { Lang } from '../messaging/templates.js';

/** How the clinic pays: month to month, or a six-month commitment. Set by the platform. */
export type BillingTerm = 'monthly' | 'six_months';

export interface ClinicRow {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  contact_phone: string | null;
  timezone: string;
  default_language: Lang;
  booking_cutoff_time: string;
  monthly_message_quota: number;
  whatsapp_phone_number_id: string | null;
  follow_up_lead_days: number;
  whatsapp_display_number: string | null;
  booking_window_days: number;
  billing_term: BillingTerm;
  subscription_ends_at: string | null;
  enabled_languages: Lang[];
  created_at: Date;
}

export function toClinicDto(row: ClinicRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    address: row.address,
    contactPhone: row.contact_phone,
    timezone: row.timezone,
    defaultLanguage: row.default_language,
    bookingCutoffTime: row.booking_cutoff_time.slice(0, 5),
    monthlyMessageQuota: row.monthly_message_quota,
    whatsappPhoneNumberId: row.whatsapp_phone_number_id,
    followUpLeadDays: row.follow_up_lead_days,
    whatsappDisplayNumber: row.whatsapp_display_number,
    bookingWindowDays: row.booking_window_days,
    billingTerm: row.billing_term,
    subscriptionEndsAt: row.subscription_ends_at,
    enabledLanguages: row.enabled_languages,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getClinicById(db: Db, clinicId: string): Promise<ClinicRow | null> {
  const { rows } = await db.query<ClinicRow>('SELECT * FROM clinics WHERE id = $1', [clinicId]);
  return rows[0] ?? null;
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'clinic'}-${randomBytes(3).toString('hex')}`;
}

export interface ClinicInput {
  name: string;
  address?: string | null;
  contactPhone?: string | null;
  timezone?: string;
  defaultLanguage?: Lang;
  bookingCutoffTime?: string;
  whatsappPhoneNumberId?: string | null;
  followUpLeadDays?: number;
  whatsappDisplayNumber?: string | null;
  bookingWindowDays?: number;
  enabledLanguages?: Lang[];
}

export async function createClinic(pool: Pool, auth: AuthContext, input: ClinicInput): Promise<ClinicRow> {
  if (auth.clinicId) throw errors.conflict('clinic_exists', 'Your account already has a clinic');
  return withTransaction(pool, (client) => insertClinic(client, auth, input));
}

/** Inserts the clinic and links the owner to it. Runs inside the caller's transaction. */
async function insertClinic(client: Db, auth: AuthContext, input: ClinicInput): Promise<ClinicRow> {
  try {
    const { rows } = await client.query<ClinicRow>(
      `INSERT INTO clinics (name, slug, address, contact_phone, timezone, default_language, booking_cutoff_time, whatsapp_phone_number_id)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'Asia/Kolkata'), COALESCE($6, 'en'), COALESCE($7, '20:00')::time, $8)
       RETURNING *`,
      [
        input.name,
        slugify(input.name),
        input.address ?? null,
        input.contactPhone ?? null,
        input.timezone ?? null,
        input.defaultLanguage ?? null,
        input.bookingCutoffTime ?? null,
        input.whatsappPhoneNumberId ?? null,
      ],
    );
    // The owner's default language is always one of the languages offered.
    const enabled = [...new Set<Lang>(['en', 'hi', rows[0]!.default_language])];
    const clinic = (await client.query<ClinicRow>('UPDATE clinics SET enabled_languages = $2 WHERE id = $1 RETURNING *', [rows[0]!.id, enabled])).rows[0]!;
    await client.query(`UPDATE users SET clinic_id = $2, updated_at = now() WHERE id = $1 AND clinic_id IS NULL`, [auth.userId, clinic.id]);
    await recordAudit(client, {
      clinicId: clinic.id,
      actorUserId: auth.userId,
      action: 'clinic.created',
      entityType: 'clinic',
      entityId: clinic.id,
    });
    return clinic;
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      throw new AppError(409, 'whatsapp_number_in_use', 'This WhatsApp number is already linked to another clinic');
    }
    throw error;
  }
}

export interface SetupDay {
  weekday: number;
  startTime: string;
  endTime: string;
  maxTokens: number;
  isActive: boolean;
}

export interface SetupInput {
  clinic: ClinicInput;
  doctorName: string;
  days: SetupDay[];
}

/**
 * First-run setup for a single-doctor clinic: the clinic, its one doctor and the weekly
 * schedule are created in one transaction, so a failure leaves nothing half-configured.
 */
export async function setupClinic(pool: Pool, auth: AuthContext, input: SetupInput): Promise<ClinicRow> {
  if (auth.clinicId) throw errors.conflict('clinic_exists', 'Your account already has a clinic');
  return withTransaction(pool, async (client) => {
    const clinic = await insertClinic(client, auth, input.clinic);
    const { rows } = await client.query<{ id: string }>(`INSERT INTO doctors (clinic_id, name) VALUES ($1, $2) RETURNING id`, [
      clinic.id,
      input.doctorName,
    ]);
    const doctorId = rows[0]!.id;
    for (const day of input.days) {
      await client.query(
        `INSERT INTO doctor_schedules (clinic_id, doctor_id, weekday, start_time, end_time, max_tokens, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [clinic.id, doctorId, day.weekday, day.startTime, day.endTime, day.maxTokens, day.isActive],
      );
    }
    await recordAudit(client, {
      clinicId: clinic.id,
      actorUserId: auth.userId,
      action: 'doctor.created',
      entityType: 'doctor',
      entityId: doctorId,
      metadata: { setup: true, days: input.days.length },
    });
    return clinic;
  });
}

export async function updateClinic(pool: Pool, auth: AuthContext & { clinicId: string }, input: Partial<ClinicInput>) {
  const current = await getClinicById(pool, auth.clinicId);
  if (!current) throw errors.notFound('Clinic');
  const effectiveDefault = input.defaultLanguage ?? current.default_language;
  const nextEnabled = input.enabledLanguages ?? [...new Set<Lang>([...current.enabled_languages, effectiveDefault])];
  if (input.enabledLanguages || input.defaultLanguage) {
    if (!nextEnabled.includes(effectiveDefault)) throw errors.validation('Include the default language in the languages offered');
  }
  return withTransaction(pool, async (client) => {
    try {
      const { rows } = await client.query<ClinicRow>(
        `UPDATE clinics SET
           name = COALESCE($2, name),
           address = CASE WHEN $3::boolean THEN $4 ELSE address END,
           contact_phone = CASE WHEN $5::boolean THEN $6 ELSE contact_phone END,
           timezone = COALESCE($7, timezone),
           default_language = COALESCE($8, default_language),
           booking_cutoff_time = COALESCE($9::time, booking_cutoff_time),
           whatsapp_phone_number_id = CASE WHEN $10::boolean THEN $11 ELSE whatsapp_phone_number_id END,
           follow_up_lead_days = COALESCE($12::integer, follow_up_lead_days),
           whatsapp_display_number = CASE WHEN $13::boolean THEN $14 ELSE whatsapp_display_number END,
           booking_window_days = COALESCE($15::integer, booking_window_days),
           enabled_languages = $16::text[],
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          auth.clinicId,
          input.name ?? null,
          input.address !== undefined,
          input.address ?? null,
          input.contactPhone !== undefined,
          input.contactPhone ?? null,
          input.timezone ?? null,
          input.defaultLanguage ?? null,
          input.bookingCutoffTime ?? null,
          input.whatsappPhoneNumberId !== undefined,
          input.whatsappPhoneNumberId ?? null,
          input.followUpLeadDays ?? null,
          input.whatsappDisplayNumber !== undefined,
          input.whatsappDisplayNumber ?? null,
          input.bookingWindowDays ?? null,
          nextEnabled,
        ],
      );
      if (!rows[0]) throw errors.notFound('Clinic');
      await recordAudit(client, {
        clinicId: auth.clinicId,
        actorUserId: auth.userId,
        action: 'clinic.updated',
        entityType: 'clinic',
        entityId: auth.clinicId,
        metadata: { fields: Object.keys(input).join(',') },
      });
      return rows[0];
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new AppError(409, 'whatsapp_number_in_use', 'This WhatsApp number is already linked to another clinic');
      }
      throw error;
    }
  });
}

export async function getMessageUsage(db: Db, clinicId: string, clinic: ClinicRow, now: Date) {
  const period = periodOf(dateInTimeZone(now, clinic.timezone));
  const { rows } = await db.query<{ notifications_sent: number }>(
    'SELECT notifications_sent FROM clinic_message_usage WHERE clinic_id = $1 AND period = $2',
    [clinicId, period],
  );
  return {
    period,
    notificationsSent: rows[0]?.notifications_sent ?? 0,
    quota: clinic.monthly_message_quota,
  };
}
