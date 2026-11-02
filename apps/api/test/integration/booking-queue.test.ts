import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, createPatient, describeDb, json, request, seedClinic, TOMORROW, type Harness, type SeededClinic } from './harness.js';

async function book(h: Harness, cookie: string, doctorId: string, patientId: string, date = TOMORROW) {
  return request(h, 'POST', '/api/tokens', {
    cookie,
    body: { doctorId, date, source: 'phone', patient: { patientId }, notifyPatient: false },
  });
}

async function activeCount(h: Harness, doctorId: string): Promise<number> {
  const { rows } = await h.pool.query('SELECT active_count FROM appointment_days WHERE doctor_id = $1 AND service_date = $2', [
    doctorId,
    TOMORROW,
  ]);
  return rows[0]?.active_count ?? 0;
}

describeDb('atomic token allocation', () => {
  let h: Harness;
  let clinic: SeededClinic;

  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    clinic = await seedClinic(h, { doctors: 1, capacity: 10 });
  });
  afterAll(async () => h.close());

  it('never oversells under concurrent bookings: exactly capacity succeeds with unique numbers', async () => {
    const doctorId = clinic.doctors[0]!.id;
    const patients: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      patients.push(await createPatient(h, clinic.reception, `Concurrent Patient ${index}`));
    }

    const responses = await Promise.all(patients.map((patientId) => book(h, clinic.reception, doctorId, patientId)));
    const statuses = responses.map((response) => response.statusCode);
    expect(statuses.filter((code) => code === 201)).toHaveLength(10);
    expect(statuses.filter((code) => code === 409)).toHaveLength(20);

    const numbers = await Promise.all(
      responses.filter((r) => r.statusCode === 201).map(async (r) => (await json(r)).token.tokenNumber as number),
    );
    expect([...numbers].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await activeCount(h, doctorId)).toBe(10);

    const full = responses.find((r) => r.statusCode === 409)!;
    expect((await json(full)).error).toBe('fully_booked');
  });

  it('blocks a second live token for the same patient and leaves the counter untouched', async () => {
    const doctorId = clinic.doctors[0]!.id;
    const before = await activeCount(h, doctorId);
    // A separate clinic keeps this doctor-day free of the capacity used above.
    const second = await seedClinic(h, { doctors: 1, capacity: 5 });
    const secondDoctor = second.doctors[0]!.id;
    const patientId = await createPatient(h, second.reception, 'Repeat Visitor', '+919811100010');

    expect((await book(h, second.reception, secondDoctor, patientId)).statusCode).toBe(201);
    const duplicate = await book(h, second.reception, secondDoctor, patientId);
    expect(duplicate.statusCode).toBe(409);
    expect((await json(duplicate)).error).toBe('already_booked');
    expect(await activeCount(h, secondDoctor)).toBe(1);
    expect(await activeCount(h, doctorId)).toBe(before);
  });

  it('frees a slot on cancellation, but never reuses a token number', async () => {
    const doctorId = clinic.doctors[0]!.id;
    const { rows } = await h.pool.query(
      `SELECT t.id, t.token_number FROM tokens t JOIN doctors d ON d.id = t.doctor_id
        WHERE d.id = $1 AND t.service_date = $2 AND t.status = 'booked' ORDER BY t.token_number LIMIT 1`,
      [doctorId, TOMORROW],
    );
    const cancelled = await request(h, 'POST', `/api/tokens/${rows[0].id}/cancel`, { cookie: clinic.reception });
    expect(cancelled.statusCode).toBe(200);
    expect(await activeCount(h, doctorId)).toBe(9);

    const newPatient = await createPatient(h, clinic.reception, 'Late Arrival');
    const rebooked = await book(h, clinic.reception, doctorId, newPatient);
    expect(rebooked.statusCode).toBe(201);
    expect((await json(rebooked)).token.tokenNumber).toBe(11);
    expect(await activeCount(h, doctorId)).toBe(10);
  });

  it('closes every doctor on a clinic holiday and says why', async () => {
    const holiday = await request(h, 'POST', '/api/holidays', { cookie: clinic.owner, body: { date: TOMORROW, reason: 'Diwali' } });
    expect(holiday.statusCode).toBe(201);

    const doctorId = clinic.doctors[0]!.id;
    const patientId = await createPatient(h, clinic.reception, 'Holiday Visitor');
    const response = await book(h, clinic.reception, doctorId, patientId);
    expect(response.statusCode).toBe(409);
    expect((await json(response)).error).toBe('clinic_closed');

    const availability = await json(await request(h, 'GET', `/api/doctors/${doctorId}/availability?date=${TOMORROW}`, { cookie: clinic.reception }));
    expect(availability).toMatchObject({ open: false, reason: 'clinic_closed' });
  });

  it('rejects past dates and days without a schedule', async () => {
    const patientId = await createPatient(h, clinic.reception, 'Calendar Check');
    const past = await book(h, clinic.reception, clinic.doctors[0]!.id, patientId, '2026-10-29');
    expect(past.statusCode).toBe(400);
    expect((await json(past)).error).toBe('past_date');

    const weekly = await seedClinic(h, { doctors: 1, capacity: 3 });
    const doctor = weekly.doctors[0]!.id;
    const weeklyPatient = await createPatient(h, weekly.reception, 'Weekly Visitor');
    // Keep only Monday (weekday 1) for this doctor.
    await request(h, 'PUT', `/api/doctors/${doctor}/schedule`, {
      cookie: weekly.owner,
      body: { days: [{ weekday: 1, startTime: '10:00', endTime: '14:00', maxTokens: 3, isActive: true }] },
    });
    const notWorking = await book(h, weekly.reception, doctor, weeklyPatient, TOMORROW); // Saturday
    expect(notWorking.statusCode).toBe(409);
    expect((await json(notWorking)).error).toBe('doctor_not_available');
  });

  it('rejects a schedule with overlapping weekdays or an inverted time range', async () => {
    const doctor = clinic.doctors[0]!.id;
    const inverted = await request(h, 'PUT', `/api/doctors/${doctor}/schedule`, {
      cookie: clinic.owner,
      body: { days: [{ weekday: 2, startTime: '18:00', endTime: '10:00', maxTokens: 3 }] },
    });
    expect(inverted.statusCode).toBe(400);

    const duplicateDay = await request(h, 'PUT', `/api/doctors/${doctor}/schedule`, {
      cookie: clinic.owner,
      body: {
        days: [
          { weekday: 2, startTime: '10:00', endTime: '12:00', maxTokens: 3 },
          { weekday: 2, startTime: '14:00', endTime: '16:00', maxTokens: 3 },
        ],
      },
    });
    expect(duplicateDay.statusCode).toBe(400);
  });
});

describeDb('queue lifecycle', () => {
  let h: Harness;
  let clinic: SeededClinic;
  const tokens: { id: string; number: number }[] = [];

  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    clinic = await seedClinic(h, { doctors: 2, capacity: 10 });
    for (let index = 1; index <= 3; index += 1) {
      const patientId = await createPatient(h, clinic.reception, `Queue Patient ${index}`, `+9198111000${index.toString().padStart(2, '0')}`);
      const response = await book(h, clinic.reception, clinic.doctors[0]!.id, patientId);
      const body = await json(response);
      tokens.push({ id: body.token.id, number: body.token.tokenNumber });
    }
  });
  afterAll(async () => h.close());

  it('calls the earliest checked-in patient, not the earliest booked one', async () => {
    const doctor = clinic.doctors[0]!;
    await request(h, 'POST', `/api/tokens/${tokens[1]!.id}/check-in`, { cookie: clinic.reception });
    await request(h, 'POST', `/api/tokens/${tokens[2]!.id}/check-in`, { cookie: clinic.reception });

    const called = await json(
      await request(h, 'POST', '/api/queue/call-next', { cookie: doctor.cookie, body: { doctorId: doctor.id, date: TOMORROW } }),
    );
    expect(called.token).toMatchObject({ tokenNumber: 2, status: 'in_consultation' });
  });

  it('allows only one patient in consultation at a time', async () => {
    const doctor = clinic.doctors[0]!;
    const second = await request(h, 'POST', '/api/queue/call-next', { cookie: doctor.cookie, body: { doctorId: doctor.id, date: TOMORROW } });
    expect(second.statusCode).toBe(409);
    expect((await json(second)).error).toBe('consultation_in_progress');
  });

  it('completes the consultation and moves on to the next waiting patient', async () => {
    const doctor = clinic.doctors[0]!;
    const done = await request(h, 'POST', `/api/tokens/${tokens[1]!.id}/complete`, { cookie: doctor.cookie });
    expect(done.statusCode).toBe(200);
    expect((await json(done)).status).toBe('completed');

    const next = await json(
      await request(h, 'POST', '/api/queue/call-next', { cookie: doctor.cookie, body: { doctorId: doctor.id, date: TOMORROW } }),
    );
    expect(next.token.tokenNumber).toBe(3);
  });

  it('returns null when nobody is waiting', async () => {
    const doctor = clinic.doctors[0]!;
    await request(h, 'POST', `/api/tokens/${tokens[2]!.id}/complete`, { cookie: doctor.cookie });
    const empty = await json(
      await request(h, 'POST', '/api/queue/call-next', { cookie: doctor.cookie, body: { doctorId: doctor.id, date: TOMORROW } }),
    );
    expect(empty.token).toBeNull();
  });

  it('enforces valid status transitions', async () => {
    const doctor = clinic.doctors[0]!;
    // Token 1 is still "booked": it cannot be completed without being called first.
    const complete = await request(h, 'POST', `/api/tokens/${tokens[0]!.id}/complete`, { cookie: doctor.cookie });
    expect(complete.statusCode).toBe(409);

    const noShow = await request(h, 'POST', `/api/tokens/${tokens[0]!.id}/no-show`, { cookie: clinic.reception });
    expect(noShow.statusCode).toBe(200);
    const again = await request(h, 'POST', `/api/tokens/${tokens[0]!.id}/no-show`, { cookie: clinic.reception });
    expect(again.statusCode).toBe(409);
    // A no-show still occupies its slot; only cancellation releases it.
    expect(await activeCount(h, doctor.id)).toBe(3);
  });

  it('shows the queue to the doctor with masked phone numbers only', async () => {
    const doctor = clinic.doctors[0]!;
    const queue = await json(await request(h, 'GET', `/api/queue?doctorId=${doctor.id}&date=${TOMORROW}`, { cookie: doctor.cookie }));
    expect(queue.tokens).toHaveLength(3);
    expect(queue.tokens[0].phoneMasked).toMatch(/^\+91\*{6}\d{4}$/);
    expect(JSON.stringify(queue)).not.toMatch(/98111000\d\d/);
  });

  it('gives owners a per-doctor summary', async () => {
    const summary = await json(await request(h, 'GET', `/api/queue/summary?date=${TOMORROW}`, { cookie: clinic.owner }));
    const first = summary.find((row: { doctorId: string }) => row.doctorId === clinic.doctors[0]!.id);
    expect(first).toMatchObject({ capacity: 10, activeCount: 3, completed: 2, noShow: 1 });
  });
});
