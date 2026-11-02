import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, describeDb, json, request, signupOwner, type Harness } from './harness.js';

describeDb('single-doctor setup', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
  });
  afterAll(async () => h.close());

  const days = [
    { weekday: 1, startTime: '10:00', endTime: '14:00', maxTokens: 25 },
    { weekday: 3, startTime: '17:00', endTime: '20:00', maxTokens: 15 },
  ];

  it('creates the clinic, its doctor and the weekly schedule in one call', async () => {
    const cookie = await signupOwner(h);
    const response = await request(h, 'POST', '/api/clinic/setup', {
      cookie,
      body: { clinicName: 'Sharma Clinic', doctorName: 'Dr. Sharma', days },
    });
    expect(response.statusCode).toBe(201);
    expect(await json(response)).toMatchObject({ name: 'Sharma Clinic' });

    const doctors = await json(await request(h, 'GET', '/api/doctors', { cookie }));
    expect(doctors).toHaveLength(1);
    expect(doctors[0]).toMatchObject({ name: 'Dr. Sharma', isActive: true, workingDays: [1, 3] });

    const schedule = await json(await request(h, 'GET', `/api/doctors/${doctors[0].id}/schedule`, { cookie }));
    expect(schedule).toEqual([
      { weekday: 1, startTime: '10:00', endTime: '14:00', maxTokens: 25, isActive: true },
      { weekday: 3, startTime: '17:00', endTime: '20:00', maxTokens: 15, isActive: true },
    ]);
  });

  it('refuses a second setup for the same owner', async () => {
    const cookie = await signupOwner(h);
    const first = await request(h, 'POST', '/api/clinic/setup', { cookie, body: { clinicName: 'First Clinic', doctorName: 'Dr. One', days } });
    expect(first.statusCode).toBe(201);
    const second = await request(h, 'POST', '/api/clinic/setup', { cookie, body: { clinicName: 'Second Clinic', doctorName: 'Dr. Two', days } });
    expect(second.statusCode).toBe(409);
    expect((await json(second)).error).toBe('clinic_exists');
  });

  it('rejects a schedule with an end time before the start time and creates nothing', async () => {
    const cookie = await signupOwner(h);
    const response = await request(h, 'POST', '/api/clinic/setup', {
      cookie,
      body: { clinicName: 'Broken Clinic', doctorName: 'Dr. Broken', days: [{ weekday: 2, startTime: '14:00', endTime: '10:00', maxTokens: 10 }] },
    });
    expect(response.statusCode).toBe(400);
    expect((await json(response)).error).toBe('validation_failed');

    const clinic = await request(h, 'GET', '/api/clinic', { cookie });
    expect(clinic.statusCode).toBe(409);
    expect((await json(clinic)).error).toBe('onboarding_required');
  });
});
