import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, describeDb, json, login, PASSWORD, request, seedClinic, signupOwner, uniqueEmail, type Harness, type SeededClinic } from './harness.js';

describeDb('authentication', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
  });
  afterAll(async () => h.close());

  it('signs up an owner, sets an HttpOnly SameSite=Lax session cookie and returns the user', async () => {
    const email = uniqueEmail('auth');
    const response = await request(h, 'POST', '/api/auth/signup', {
      body: { email, password: PASSWORD, fullName: 'Asha Verma' },
    });
    expect(response.statusCode).toBe(201);
    const body = await json(response);
    expect(body.user).toMatchObject({ email, role: 'owner', fullName: 'Asha Verma' });
    expect(body.clinic).toBeNull();

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('dc_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure');
  });

  it('rejects a duplicate email with 409 and weak passwords with 400', async () => {
    const email = uniqueEmail('dup');
    await signupOwner(h, email);
    const duplicate = await request(h, 'POST', '/api/auth/signup', { body: { email, password: PASSWORD, fullName: 'Someone' } });
    expect(duplicate.statusCode).toBe(409);
    expect((await json(duplicate)).error).toBe('email_taken');

    const weak = await request(h, 'POST', '/api/auth/signup', {
      body: { email: uniqueEmail('weak'), password: 'short', fullName: 'Someone' },
    });
    expect(weak.statusCode).toBe(400);
    expect((await json(weak)).error).toBe('validation_failed');
  });

  it('gives the same generic error for a wrong password and an unknown email', async () => {
    const email = uniqueEmail('generic');
    await signupOwner(h, email);
    const wrongPassword = await request(h, 'POST', '/api/auth/login', { body: { email, password: 'Not-The-Password-1' } });
    const unknownEmail = await request(h, 'POST', '/api/auth/login', {
      body: { email: uniqueEmail('nobody'), password: 'Not-The-Password-1' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(await json(wrongPassword)).toEqual(await json(unknownEmail));
  });

  it('locks the account for 15 minutes after five failed attempts, even with the right password', async () => {
    const email = uniqueEmail('lockout');
    await signupOwner(h, email);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(h, 'POST', '/api/auth/login', { body: { email, password: 'wrong-password-1' } });
    }
    const correct = await request(h, 'POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    expect(correct.statusCode).toBe(401);

    await h.pool.query(`UPDATE users SET locked_until = now() - interval '1 minute' WHERE email = $1`, [email]);
    const afterLock = await request(h, 'POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    expect(afterLock.statusCode).toBe(200);
  });

  it('invalidates the session on logout and reports the current user while signed in', async () => {
    const cookie = await signupOwner(h);
    const me = await request(h, 'GET', '/api/auth/me', { cookie });
    expect(me.statusCode).toBe(200);

    const logout = await request(h, 'POST', '/api/auth/logout', { cookie });
    expect(logout.statusCode).toBe(204);

    const after = await request(h, 'GET', '/api/auth/me', { cookie });
    expect(after.statusCode).toBe(401);
  });

  it('signs out other sessions when the password changes', async () => {
    const email = uniqueEmail('pwchange');
    const first = await signupOwner(h, email);
    const second = await login(h, email);

    const change = await request(h, 'POST', '/api/auth/change-password', {
      cookie: first,
      body: { currentPassword: PASSWORD, newPassword: 'Brand-New-Pass-2' },
    });
    expect(change.statusCode).toBe(200);
    expect((await request(h, 'GET', '/api/auth/me', { cookie: second })).statusCode).toBe(401);
    expect((await request(h, 'GET', '/api/auth/me', { cookie: first })).statusCode).toBe(200);
  });

  it('refuses state-changing requests from an origin that is not allowed', async () => {
    const cookie = await signupOwner(h);
    const response = await request(h, 'POST', '/api/clinic', {
      cookie,
      body: { name: 'Evil Clinic' },
      headers: { origin: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect((await json(response)).error).toBe('bad_origin');
  });

  it('returns 400 for malformed JSON instead of crashing', async () => {
    const response = await request(h, 'POST', '/api/auth/login', { rawPayload: '{"email":' });
    expect(response.statusCode).toBe(400);
  });
});

describeDb('role permissions and clinic isolation', () => {
  let h: Harness;
  let a: SeededClinic;
  let b: SeededClinic;

  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    a = await seedClinic(h, { name: 'Clinic Alpha', doctors: 2 });
    b = await seedClinic(h, { name: 'Clinic Beta', doctors: 1 });
  });
  afterAll(async () => h.close());

  it('requires sign-in and a clinic for clinical endpoints', async () => {
    expect((await request(h, 'GET', '/api/queue?doctorId=00000000-0000-4000-8000-000000000000&date=2026-10-31')).statusCode).toBe(401);

    const newOwner = await signupOwner(h);
    const response = await request(h, 'GET', '/api/patients', { cookie: newOwner });
    expect(response.statusCode).toBe(409);
    expect((await json(response)).error).toBe('onboarding_required');
  });

  it('blocks reception from owner-only management and from the audit log', async () => {
    const create = await request(h, 'POST', '/api/doctors', { cookie: a.reception, body: { name: 'Dr Intruder' } });
    expect(create.statusCode).toBe(403);
    expect((await request(h, 'GET', '/api/audit-logs', { cookie: a.reception })).statusCode).toBe(403);
    expect((await request(h, 'GET', '/api/staff', { cookie: a.reception })).statusCode).toBe(403);
  });

  it('stops a doctor from acting on another doctor\'s queue', async () => {
    const response = await request(h, 'POST', '/api/queue/call-next', {
      cookie: a.doctors[0]!.cookie,
      body: { doctorId: a.doctors[1]!.id, date: '2026-10-31' },
    });
    expect(response.statusCode).toBe(403);

    const reading = await request(h, 'GET', `/api/queue?doctorId=${a.doctors[1]!.id}&date=2026-10-31`, {
      cookie: a.doctors[0]!.cookie,
    });
    expect(reading.statusCode).toBe(403);
  });

  it('never lets one clinic read or change another clinic\'s records', async () => {
    const betaDoctor = b.doctors[0]!.id;
    const betaPatientId = (
      await json(await request(h, 'POST', '/api/patients', { cookie: b.reception, body: { fullName: 'Beta Patient', phone: '+919811100077' } }))
    ).id as string;

    // Alpha staff cannot see Beta's patient, queue or doctor.
    expect((await request(h, 'GET', `/api/patients/${betaPatientId}`, { cookie: a.reception })).statusCode).toBe(404);
    expect((await request(h, 'GET', `/api/queue?doctorId=${betaDoctor}&date=2026-10-31`, { cookie: a.owner })).statusCode).toBe(404);
    const alphaPatients = await json(await request(h, 'GET', '/api/patients?q=Beta', { cookie: a.reception }));
    expect(alphaPatients).toEqual([]);

    // Alpha owner cannot edit Beta's doctor, nor book Beta's doctor for an Alpha patient.
    expect(
      (await request(h, 'PATCH', `/api/doctors/${betaDoctor}`, { cookie: a.owner, body: { name: 'Hijacked' } })).statusCode,
    ).toBe(404);
    const alphaPatientId = (await json(await request(h, 'POST', '/api/patients', { cookie: a.reception, body: { fullName: 'Alpha Patient' } }))).id;
    expect(
      (
        await request(h, 'POST', '/api/tokens', {
          cookie: a.reception,
          body: { doctorId: betaDoctor, date: '2026-10-31', source: 'phone', patient: { patientId: alphaPatientId }, notifyPatient: false },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(h, 'POST', '/api/tokens', {
          cookie: a.reception,
          body: { doctorId: a.doctors[0]!.id, date: '2026-10-31', source: 'phone', patient: { patientId: betaPatientId }, notifyPatient: false },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('does not reveal another clinic\'s audit trail', async () => {
    const response = await json(await request(h, 'GET', '/api/audit-logs', { cookie: a.owner }));
    const actions = response.items.map((item: { action: string }) => item.action);
    expect(actions).toContain('clinic.created');
    const betaClinicId = b.clinicId;
    const leaked = response.items.filter((item: { entityId: string | null }) => item.entityId === betaClinicId);
    expect(leaked).toEqual([]);
  });

  it('lets the owner reset a staff password and ends that person\'s existing sessions', async () => {
    const staffCookie = a.reception;
    const staffList = await json(await request(h, 'GET', '/api/staff', { cookie: a.owner }));
    const receptionist = staffList.find((member: { role: string }) => member.role === 'receptionist');
    const reset = await request(h, 'POST', `/api/staff/${receptionist.id}/reset-password`, { cookie: a.owner });
    expect(reset.statusCode).toBe(200);
    const { temporaryPassword } = await json(reset);

    expect((await request(h, 'GET', '/api/auth/me', { cookie: staffCookie })).statusCode).toBe(401);
    const withNewPassword = await request(h, 'POST', '/api/auth/login', {
      body: { email: receptionist.email, password: temporaryPassword },
    });
    expect(withNewPassword.statusCode).toBe(200);

    const other = await seedClinic(h, { doctors: 1 });
    const crossClinic = await request(h, 'POST', `/api/staff/${receptionist.id}/reset-password`, { cookie: other.owner });
    expect(crossClinic.statusCode).toBe(404);
  });

  it('stores the session cookie only as a hash and removes staff access when deactivated', async () => {
    const cookie = a.reception;
    const token = cookie.replace('dc_session=', '');
    const { rows } = await h.pool.query(`SELECT token_hash FROM sessions WHERE token_hash = $1`, [token]);
    expect(rows).toHaveLength(0);
    const { rows: hashed } = await h.pool.query(`SELECT count(*)::int AS n FROM sessions WHERE token_hash <> $1`, [token]);
    expect(hashed[0].n).toBeGreaterThan(0);

    const staffList = await json(await request(h, 'GET', '/api/staff', { cookie: a.owner }));
    const receptionist = staffList.find((member: { role: string }) => member.role === 'receptionist');
    const deactivate = await request(h, 'PATCH', `/api/staff/${receptionist.id}`, { cookie: a.owner, body: { isActive: false } });
    expect(deactivate.statusCode).toBe(200);
    expect((await request(h, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401);
  });
});
