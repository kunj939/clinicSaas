import type { Db } from '../../db/pool.js';
import { weekdayOf } from '../../lib/clinic-time.js';
import { errors } from '../../lib/errors.js';

export type UnavailableReason =
  | 'doctor_inactive'
  | 'not_scheduled'
  | 'clinic_closed'
  | 'past_date'
  | 'fully_booked';

export interface Availability {
  doctorId: string;
  date: string;
  open: boolean;
  reason: UnavailableReason | null;
  capacity: number;
  activeCount: number;
  remaining: number;
  startTime: string | null;
  endTime: string | null;
}

/**
 * Read-only view of whether a doctor can take tokens on a date. Writers re-check these rules
 * inside their own transaction; this function is for display and fast rejection.
 */
export async function getAvailability(
  db: Db,
  input: { clinicId: string; doctorId: string; date: string; today: string },
): Promise<Availability> {
  const { rows: doctorRows } = await db.query<{ is_active: boolean }>(
    'SELECT is_active FROM doctors WHERE id = $1 AND clinic_id = $2',
    [input.doctorId, input.clinicId],
  );
  if (!doctorRows[0]) throw errors.notFound('Doctor');

  const { rows: scheduleRows } = await db.query<{
    start_time: string;
    end_time: string;
    max_tokens: number;
    is_active: boolean;
  }>(
    `SELECT start_time, end_time, max_tokens, is_active
       FROM doctor_schedules WHERE doctor_id = $1 AND weekday = $2`,
    [input.doctorId, weekdayOf(input.date)],
  );
  const schedule = scheduleRows[0];

  const { rows: holidayRows } = await db.query(
    'SELECT 1 FROM clinic_holidays WHERE clinic_id = $1 AND holiday_date = $2',
    [input.clinicId, input.date],
  );

  const { rows: dayRows } = await db.query<{ active_count: number }>(
    'SELECT active_count FROM appointment_days WHERE doctor_id = $1 AND service_date = $2',
    [input.doctorId, input.date],
  );

  const capacity = schedule?.max_tokens ?? 0;
  const activeCount = dayRows[0]?.active_count ?? 0;
  const remaining = Math.max(capacity - activeCount, 0);
  const base = {
    doctorId: input.doctorId,
    date: input.date,
    capacity,
    activeCount,
    remaining,
    startTime: schedule ? schedule.start_time.slice(0, 5) : null,
    endTime: schedule ? schedule.end_time.slice(0, 5) : null,
  };

  let reason: UnavailableReason | null = null;
  if (input.date < input.today) reason = 'past_date';
  else if (!doctorRows[0].is_active) reason = 'doctor_inactive';
  else if (holidayRows.length > 0) reason = 'clinic_closed';
  else if (!schedule || !schedule.is_active) reason = 'not_scheduled';
  else if (remaining <= 0) reason = 'fully_booked';

  return { ...base, open: reason === null, reason };
}
