import type { AuthContext } from '../../auth/session.js';
import type { Db } from '../../db/pool.js';
import type { FieldCipher } from '../../lib/crypto.js';
import { can } from '../../lib/permissions.js';
import { maskPhone } from '../../lib/phone.js';
import { PAYMENT_METHODS, type PaymentMethod } from '../visits/service.js';

export interface DiaryEntry {
  tokenId: string;
  tokenNumber: number;
  status: string;
  source: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  patientName: string;
  /** Full number for reception and owner, masked for doctors. */
  phone: string | null;
  diagnosis: string | null;
  prescription: string | null;
  medicineDays: number | null;
  followUpDate: string | null;
  feeAmount: number | null;
  amountPaid: number | null;
  paymentMethod: PaymentMethod | null;
}

export interface DiarySummary {
  patientsSeen: number;
  collected: number;
  due: number;
  byMethod: Record<PaymentMethod, number>;
}

export interface DiaryDto {
  date: string;
  entries: DiaryEntry[];
  summary: DiarySummary;
}

/** One day's register: every token for the date with its consultation and payment, in doctor and token order. */
export async function getDiary(
  db: Db,
  cipher: FieldCipher,
  auth: AuthContext & { clinicId: string },
  options: { date: string; doctorId?: string },
): Promise<DiaryDto> {
  const doctorFilter = auth.role === 'doctor' ? auth.doctorId : (options.doctorId ?? null);
  const showFullPhone = can(auth.role, 'patients.write');

  const { rows } = await db.query(
    `SELECT t.id AS token_id, t.token_number, t.status, t.source, t.doctor_id, d.name AS doctor_name,
            p.id AS patient_id, p.full_name, p.phone_encrypted,
            v.diagnosis, v.prescription, v.medicine_days, v.follow_up_date,
            v.fee_amount, v.amount_paid, v.payment_method
       FROM tokens t
       JOIN patients p ON p.id = t.patient_id
       JOIN doctors d ON d.id = t.doctor_id
       LEFT JOIN visits v ON v.token_id = t.id
      WHERE t.clinic_id = $1 AND t.service_date = $2 AND t.status <> 'cancelled'
        AND ($3::uuid IS NULL OR t.doctor_id = $3)
      ORDER BY d.name, t.token_number`,
    [auth.clinicId, options.date, doctorFilter],
  );

  const entries: DiaryEntry[] = rows.map((row) => {
    const fullPhone = row.phone_encrypted ? cipher.decrypt(row.phone_encrypted) : null;
    return {
      tokenId: row.token_id,
      tokenNumber: row.token_number,
      status: row.status,
      source: row.source,
      doctorId: row.doctor_id,
      doctorName: row.doctor_name,
      patientId: row.patient_id,
      patientName: row.full_name,
      phone: fullPhone && (showFullPhone ? fullPhone : maskPhone(fullPhone)),
      diagnosis: row.diagnosis,
      prescription: row.prescription,
      medicineDays: row.medicine_days,
      followUpDate: row.follow_up_date,
      feeAmount: row.fee_amount,
      amountPaid: row.amount_paid,
      paymentMethod: row.payment_method,
    };
  });

  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((method) => [method, 0])) as Record<PaymentMethod, number>;
  let collected = 0;
  let due = 0;
  let patientsSeen = 0;
  for (const entry of entries) {
    if (entry.status === 'completed') patientsSeen += 1;
    if (entry.amountPaid && entry.paymentMethod) {
      byMethod[entry.paymentMethod] += entry.amountPaid;
      collected += entry.amountPaid;
    }
    if (entry.feeAmount !== null) due += Math.max(0, entry.feeAmount - (entry.amountPaid ?? 0));
  }

  return { date: options.date, entries, summary: { patientsSeen, collected, due, byMethod } };
}
