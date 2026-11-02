import type { Db } from '../../db/pool.js';
import type { FieldCipher } from '../../lib/crypto.js';
import { errors, isPgError, PG_UNIQUE_VIOLATION, AppError } from '../../lib/errors.js';
import { maskPhone, normalizePhone } from '../../lib/phone.js';
import { can, type Role } from '../../lib/permissions.js';
import type { Lang } from '../messaging/templates.js';

export interface PatientRow {
  id: string;
  full_name: string;
  phone_hash: string | null;
  phone_encrypted: string | null;
  gender: string | null;
  age_years: number | null;
  preferred_language: Lang;
  created_at: Date;
}

export interface PatientInput {
  fullName: string;
  /** Already normalised to E.164, or null for walk-ins without a number. */
  phone: string | null;
  gender?: 'male' | 'female' | 'other' | null;
  ageYears?: number | null;
  preferredLanguage?: Lang;
}

export function toPatientDto(row: PatientRow, cipher: FieldCipher, viewerRole: Role) {
  const phone = row.phone_encrypted ? cipher.decrypt(row.phone_encrypted) : null;
  return {
    id: row.id,
    fullName: row.full_name,
    phoneMasked: phone ? maskPhone(phone) : null,
    // Full numbers are only shown where staff need them to contact the patient.
    phone: phone && can(viewerRole, 'patients.write') ? phone : undefined,
    gender: row.gender,
    ageYears: row.age_years,
    preferredLanguage: row.preferred_language,
    createdAt: row.created_at.toISOString(),
  };
}

export async function findPatientByPhone(db: Db, cipher: FieldCipher, clinicId: string, e164: string): Promise<PatientRow | null> {
  const { rows } = await db.query<PatientRow>(
    'SELECT * FROM patients WHERE clinic_id = $1 AND phone_hash = $2',
    [clinicId, cipher.blindIndex(e164)],
  );
  return rows[0] ?? null;
}

export async function createPatient(db: Db, cipher: FieldCipher, clinicId: string, input: PatientInput): Promise<PatientRow> {
  try {
    const { rows } = await db.query<PatientRow>(
      `INSERT INTO patients (clinic_id, full_name, phone_hash, phone_encrypted, gender, age_years, preferred_language)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        clinicId,
        input.fullName,
        input.phone ? cipher.blindIndex(input.phone) : null,
        input.phone ? cipher.encrypt(input.phone) : null,
        input.gender ?? null,
        input.ageYears ?? null,
        input.preferredLanguage ?? 'en',
      ],
    );
    return rows[0]!;
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      throw new AppError(409, 'patient_exists', 'A patient with this phone number already exists');
    }
    throw error;
  }
}

/** Returns the existing patient for a phone number, or creates one. Used by phone and WhatsApp bookings. */
export async function findOrCreatePatientByPhone(
  db: Db,
  cipher: FieldCipher,
  clinicId: string,
  input: { fullName: string; phone: string; preferredLanguage?: Lang; gender?: 'male' | 'female' | 'other' | null; ageYears?: number | null },
): Promise<PatientRow> {
  const existing = await findPatientByPhone(db, cipher, clinicId, input.phone);
  if (existing) return existing;
  return createPatient(db, cipher, clinicId, input);
}

export async function getPatient(db: Db, clinicId: string, patientId: string): Promise<PatientRow> {
  const { rows } = await db.query<PatientRow>('SELECT * FROM patients WHERE id = $1 AND clinic_id = $2', [
    patientId,
    clinicId,
  ]);
  if (!rows[0]) throw errors.notFound('Patient');
  return rows[0];
}

export async function searchPatients(
  db: Db,
  cipher: FieldCipher,
  clinicId: string,
  query: string,
  limit: number,
  viewerRole: Role,
) {
  const trimmed = query.trim();
  const looksLikePhone = /^\+?[\d\s\-()]{6,}$/.test(trimmed);
  const e164 = looksLikePhone ? normalizePhone(trimmed) : null;

  let rows: PatientRow[];
  if (e164) {
    rows = (
      await db.query<PatientRow>('SELECT * FROM patients WHERE clinic_id = $1 AND phone_hash = $2 LIMIT 1', [
        clinicId,
        cipher.blindIndex(e164),
      ])
    ).rows;
  } else {
    const pattern = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    rows = (
      await db.query<PatientRow>(
        `SELECT * FROM patients
          WHERE clinic_id = $1 AND ($2 = '' OR full_name ILIKE $3)
          ORDER BY full_name
          LIMIT $4`,
        [clinicId, trimmed, pattern, limit],
      )
    ).rows;
  }
  return rows.map((row) => toPatientDto(row, cipher, viewerRole));
}

export async function updatePatient(
  db: Db,
  cipher: FieldCipher,
  clinicId: string,
  patientId: string,
  patch: Partial<Pick<PatientInput, 'fullName' | 'gender' | 'ageYears' | 'preferredLanguage'>> & { phone?: string | null },
): Promise<PatientRow> {
  const current = await getPatient(db, clinicId, patientId);
  const phoneTouched = patch.phone !== undefined;
  try {
    const { rows } = await db.query<PatientRow>(
      `UPDATE patients SET
         full_name = COALESCE($3, full_name),
         gender = CASE WHEN $4::boolean THEN $5 ELSE gender END,
         age_years = CASE WHEN $6::boolean THEN $7::smallint ELSE age_years END,
         preferred_language = COALESCE($8, preferred_language),
         phone_hash = CASE WHEN $9::boolean THEN $10 ELSE phone_hash END,
         phone_encrypted = CASE WHEN $9::boolean THEN $11 ELSE phone_encrypted END,
         updated_at = now()
       WHERE id = $1 AND clinic_id = $2
       RETURNING *`,
      [
        current.id,
        clinicId,
        patch.fullName ?? null,
        patch.gender !== undefined,
        patch.gender ?? null,
        patch.ageYears !== undefined,
        patch.ageYears ?? null,
        patch.preferredLanguage ?? null,
        phoneTouched,
        patch.phone ? cipher.blindIndex(patch.phone) : null,
        patch.phone ? cipher.encrypt(patch.phone) : null,
      ],
    );
    return rows[0]!;
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      throw new AppError(409, 'patient_exists', 'Another patient already uses this phone number');
    }
    throw error;
  }
}
