import { afterAll, beforeAll, expect, it } from 'vitest';
import { sendDueFollowUpReminders } from '../../src/modules/visits/service.js';
import { createHarness, createPatient, describeDb, json, request, seedClinic, TODAY, type Harness, type SeededClinic } from './harness.js';

/** Books a walk-in for today, calls them in and returns the token id. */
async function walkInInConsultation(h: Harness, clinic: SeededClinic, fullName: string, phone: string): Promise<string> {
  const doctor = clinic.doctors[0]!;
  const booked = await json(
    await request(h, 'POST', '/api/tokens', {
      cookie: clinic.reception,
      body: { doctorId: doctor.id, date: TODAY, source: 'walk_in', patient: { fullName, phone }, notifyPatient: false },
    }),
  );
  const called = await json(
    await request(h, 'POST', '/api/queue/call-next', { cookie: doctor.cookie, body: { doctorId: doctor.id, date: TODAY } }),
  );
  expect(called.token.id).toBe(booked.token.id);
  // Only one patient is in consultation at a time, so the next walk-in needs this one completed.
  await request(h, 'POST', `/api/tokens/${booked.token.id}/complete`, { cookie: doctor.cookie });
  return booked.token.id as string;
}

describeDb('medicine follow-ups, diary and payments', () => {
  let h: Harness;
  let clinic: SeededClinic;

  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    clinic = await seedClinic(h, { doctors: 1, capacity: 20 });
  });
  afterAll(async () => h.close());

  it('sets the follow-up the day before a medicine course runs out, using the clinic lead time', async () => {
    const tokenId = await walkInInConsultation(h, clinic, 'Course Patient', '+919800011111');
    const doctor = clinic.doctors[0]!;

    // Default lead time is one day: 30 days of medicine from 2026-10-30 ends on 2026-11-29, so follow up on 2026-11-28.
    const saved = await json(
      await request(h, 'PUT', `/api/tokens/${tokenId}/visit`, { cookie: doctor.cookie, body: { diagnosis: 'Fever', medicineDays: 30 } }),
    );
    expect(saved).toMatchObject({ medicineDays: 30, followUpDate: '2026-11-28' });

    const followUps = await json(await request(h, 'GET', '/api/follow-ups?status=open', { cookie: doctor.cookie }));
    expect(followUps.find((item: { dueDate: string }) => item.dueDate === '2026-11-28')).toBeTruthy();

    // An explicit date still wins over the medicine course.
    const explicit = await json(
      await request(h, 'PUT', `/api/tokens/${tokenId}/visit`, {
        cookie: doctor.cookie,
        body: { medicineDays: 30, followUpDate: '2026-12-05' },
      }),
    );
    expect(explicit.followUpDate).toBe('2026-12-05');
  });

  it('uses the clinic lead time when the owner changes it', async () => {
    const patientId = await createPatient(h, clinic.reception, 'Lead Patient', '+919800022222');
    expect(patientId).toBeTruthy();
    const patch = await request(h, 'PATCH', '/api/clinic', { cookie: clinic.owner, body: { followUpLeadDays: 3 } });
    expect(patch.statusCode).toBe(200);
    expect(await json(patch)).toMatchObject({ followUpLeadDays: 3 });

    const tokenId = await walkInInConsultation(h, clinic, 'Lead Two', '+919800033333');
    const saved = await json(
      await request(h, 'PUT', `/api/tokens/${tokenId}/visit`, { cookie: clinic.doctors[0]!.cookie, body: { medicineDays: 30 } }),
    );
    // 30 days minus a 3-day lead: follow up on 2026-11-26.
    expect(saved.followUpDate).toBe('2026-11-26');

    await request(h, 'PATCH', '/api/clinic', { cookie: clinic.owner, body: { followUpLeadDays: 1 } });
  });

  it('records a payment, rejects a payment without a method, and totals it in the diary', async () => {
    const tokenId = await walkInInConsultation(h, clinic, 'Paying Patient', '+919800044444');

    const missingMethod = await request(h, 'PUT', `/api/tokens/${tokenId}/payment`, {
      cookie: clinic.reception,
      body: { feeAmount: 500, amountPaid: 300, paymentMethod: null },
    });
    expect(missingMethod.statusCode).toBe(400);

    const paid = await request(h, 'PUT', `/api/tokens/${tokenId}/payment`, {
      cookie: clinic.reception,
      body: { feeAmount: 500, amountPaid: 500, paymentMethod: 'upi' },
    });
    expect(paid.statusCode).toBe(200);
    expect(await json(paid)).toMatchObject({ feeAmount: 500, amountPaid: 500, paymentMethod: 'upi' });

    const diary = await json(await request(h, 'GET', `/api/diary?date=${TODAY}`, { cookie: clinic.owner }));
    const entry = diary.entries.find((item: { tokenId: string }) => item.tokenId === tokenId);
    expect(entry).toMatchObject({ patientName: 'Paying Patient', feeAmount: 500, amountPaid: 500, paymentMethod: 'upi' });
    expect(entry.phone).toBe('+919800044444');
    expect(diary.summary.collected).toBeGreaterThanOrEqual(500);
    expect(diary.summary.byMethod.upi).toBeGreaterThanOrEqual(500);
  });

  it('shows the doctor the diary for their own patients with masked phone numbers', async () => {
    const doctor = clinic.doctors[0]!;
    const diary = await json(await request(h, 'GET', `/api/diary?date=${TODAY}`, { cookie: doctor.cookie }));
    expect(diary.entries.length).toBeGreaterThan(0);
    for (const entry of diary.entries) {
      expect(entry.doctorId).toBe(doctor.id);
      if (entry.phone) expect(entry.phone).toMatch(/^\+91\*{6}\d{4}$/);
    }
  });

  it('keeps the diary out of reach for anyone outside the clinic', async () => {
    const other = await seedClinic(h, { doctors: 1, capacity: 5 });
    const otherDiary = await json(await request(h, 'GET', `/api/diary?date=${TODAY}`, { cookie: other.owner }));
    expect(otherDiary.entries).toHaveLength(0);
    const ourDiary = await json(await request(h, 'GET', `/api/diary?date=${TODAY}`, { cookie: clinic.owner }));
    expect(ourDiary.entries.length).toBeGreaterThan(0);
    expect(otherDiary.summary.collected).toBe(0);
  });

  it('refuses a new walk-in patient without a phone number', async () => {
    const response = await request(h, 'POST', '/api/tokens', {
      cookie: clinic.reception,
      body: { doctorId: clinic.doctors[0]!.id, date: TODAY, source: 'walk_in', patient: { fullName: 'No Phone' }, notifyPatient: false },
    });
    expect(response.statusCode).toBe(400);
    expect((await json(response)).error).toBe('validation_failed');
  });

  it('queues the reminder once, on the due date, without anyone clicking', async () => {
    const patientId = await createPatient(h, clinic.reception, 'Due Patient', '+919800055555');
    const doctor = clinic.doctors[0]!;
    const created = await json(
      await request(h, 'POST', '/api/follow-ups', {
        cookie: doctor.cookie,
        body: { patientId, doctorId: doctor.id, dueDate: TODAY, reason: 'Medicine ends tomorrow' },
      }),
    );

    const first = await sendDueFollowUpReminders(h.ctx);
    expect(first).toBeGreaterThanOrEqual(1);
    const { rows } = await h.pool.query(`SELECT kind, template_key FROM outbound_messages WHERE dedupe_key = $1`, [
      `followup:${created.id}:${TODAY}`,
    ]);
    expect(rows).toEqual([{ kind: 'notification', template_key: 'follow_up_reminder' }]);

    const second = await sendDueFollowUpReminders(h.ctx);
    expect(second).toBe(0);
  });
});
