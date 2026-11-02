import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, describeDb, json, request, seedClinic, TOMORROW, whatsappPayload, type Harness, type SeededClinic } from './harness.js';

const PHONE_NUMBER_ID = '111222333';
const SENDER = '919811100001';

async function inbound(h: Harness, input: { from?: string; id: string; text: string | null; phoneNumberId?: string }, headers: Record<string, string> = {}) {
  return request(h, 'POST', '/api/webhooks/whatsapp', {
    body: whatsappPayload({
      phoneNumberId: input.phoneNumberId ?? PHONE_NUMBER_ID,
      from: input.from ?? SENDER,
      messageId: input.id,
      text: input.text,
    }),
    headers,
  });
}

/** All bot/notification bodies this clinic has queued, decrypted. Used to assert on what patients receive. */
async function queuedBodies(h: Harness): Promise<string[]> {
  const { rows } = await h.pool.query('SELECT body_encrypted FROM outbound_messages');
  return rows.map((row) => h.cipher.decrypt(row.body_encrypted as string));
}

async function expectReply(h: Harness, fragment: string): Promise<void> {
  const bodies = await queuedBodies(h);
  expect(bodies.some((body) => body.includes(fragment)), `expected a reply containing "${fragment}"`).toBe(true);
}

describeDb('WhatsApp booking bot', () => {
  let h: Harness;
  let clinic: SeededClinic;

  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    clinic = await seedClinic(h, { doctors: 2, capacity: 5, whatsappPhoneNumberId: PHONE_NUMBER_ID, name: 'Sunrise Clinic' });
  });
  afterAll(async () => h.close());

  it('welcomes a new patient, takes the name, then shows doctors and confirms the token', async () => {
    expect((await inbound(h, { id: 'wamid.1', text: 'BOOK' })).statusCode).toBe(200);
    await expectReply(h, 'Reply with a number to choose your language');
    await inbound(h, { id: 'wamid.1l', text: '1' });
    await expectReply(h, 'Welcome to Sunrise Clinic');
    await expectReply(h, "Please send the patient's full name");

    await inbound(h, { id: 'wamid.2', text: 'Ravi Kumar' });
    await expectReply(h, 'Thank you, Ravi.');
    await expectReply(h, "What is the patient's age in years?");

    await inbound(h, { id: 'wamid.2a', text: '34' });
    await expectReply(h, 'Token updates and reminders will go to this WhatsApp number');

    await inbound(h, { id: 'wamid.2b', text: 'YES' });
    await expectReply(h, 'Reply with the number of the doctor');
    await expectReply(h, '1. Dr. Dr Doctor1 (5 left)');

    const confirmed = await json(await inbound(h, { id: 'wamid.3', text: '1' }));
    expect(confirmed).toMatchObject({ processed: 1 });
    await expectReply(h, 'Token #1 is booked with Dr. Dr Doctor1');

    const { rows } = await h.pool.query(
      `SELECT t.source, t.service_date, t.status, p.full_name FROM tokens t JOIN patients p ON p.id = t.patient_id
        WHERE t.doctor_id = $1`,
      [clinic.doctors[0]!.id],
    );
    expect(rows).toEqual([{ source: 'whatsapp', service_date: TOMORROW, status: 'booked', full_name: 'Ravi Kumar' }]);
  });

  it('answers STATUS and lets a returning patient book with another doctor without re-entering their name', async () => {
    await inbound(h, { id: 'wamid.4', text: 'status' });
    await expectReply(h, 'Token #1 - Dr. Dr Doctor1 - 31/10/2026 - Status: Booked');

    await inbound(h, { id: 'wamid.5', text: 'hello' });
    await inbound(h, { id: 'wamid.6', text: '2' });
    await expectReply(h, 'Token #1 is booked with Dr. Dr Doctor2');
  });

  it('lets a new patient choose Hindi, then talks to them in Hindi from then on', async () => {
    const from = '919811100050';
    await inbound(h, { id: 'wamid.7', from, text: 'बुक' });
    await expectReply(h, 'Reply with a number to choose your language');

    await inbound(h, { id: 'wamid.7a', from, text: '2' });
    await expectReply(h, 'बुकिंग पूरी करने के लिए मरीज़ का पूरा नाम भेजें');

    await inbound(h, { id: 'wamid.7b', from, text: 'स्थिति' });
    await expectReply(h, 'आज या कल का कोई सक्रिय टोकन नहीं मिला');
  });

  it('processes a provider retry of the same message only once', async () => {
    const before = (await queuedBodies(h)).length;
    const retry = await json(await inbound(h, { id: 'wamid.7', from: '919811100050', text: 'बुक' }));
    expect(retry).toMatchObject({ processed: 0, duplicates: 1 });
    expect((await queuedBodies(h)).length).toBe(before);
  });

  it('turns down online booking after the clinic cut-off time', async () => {
    h.setNow(new Date('2026-10-30T14:45:00Z')); // 20:15 IST
    await inbound(h, { id: 'wamid.9', from: '919811100002', text: 'BOOK' });
    await inbound(h, { id: 'wamid.9a', from: '919811100002', text: '1' });
    await expectReply(h, 'Online booking for tomorrow closed at 8:00 PM');
    h.setNow(new Date('2026-10-30T06:00:00Z'));
  });

  it('welcomes a new sender who starts with a picture, and gives help to a known patient with an unclear message', async () => {
    await inbound(h, { id: 'wamid.10', from: '919811100003', text: null });
    await expectReply(h, 'Welcome to Sunrise Clinic');
    // SENDER booked in the first test, so this is a known patient and the message is not a name.
    await inbound(h, { id: 'wamid.11', text: 'what is this' });
    await expectReply(h, 'Reply BOOK to book tomorrow');
  });

  it('ignores messages for numbers that are not linked to any clinic', async () => {
    const before = (await queuedBodies(h)).length;
    const response = await json(await inbound(h, { id: 'wamid.12', text: 'BOOK', phoneNumberId: '999999' }));
    expect(response).toMatchObject({ processed: 0, unrouted: 1 });
    expect((await queuedBodies(h)).length).toBe(before);
  });

  it('exposes the same bot to staff through the simulator, and the reply reaches the outbox', async () => {
    const simulated = await request(h, 'POST', '/api/messages/simulate-inbound', {
      cookie: clinic.reception,
      body: { phone: '+919811100004', text: 'BOOK' },
    });
    expect(simulated.statusCode).toBe(202);
    const messages = await json(await request(h, 'GET', '/api/messages', { cookie: clinic.reception }));
    expect(messages.some((message: { body: string }) => message.body.includes('Welcome to Sunrise Clinic'))).toBe(true);
  });

  it('does not count bot replies against the monthly notification quota', async () => {
    const usage = await json(await request(h, 'GET', '/api/clinic/usage', { cookie: clinic.owner }));
    expect(usage.notificationsSent).toBe(0);
  });

  it('does not expose the simulator when it is disabled', async () => {
    const off = await createHarness({ SIMULATOR_ENABLED: 'false', RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    try {
      const staff = await seedClinic(off, { doctors: 1 });
      const response = await request(off, 'POST', '/api/messages/simulate-inbound', {
        cookie: staff.reception,
        body: { phone: '+919811100005', text: 'BOOK' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describeDb('WhatsApp webhook security and availability', () => {
  it('requires a valid Meta signature when an app secret is configured', async () => {
    const h = await createHarness({ WHATSAPP_APP_SECRET: 'app-secret', RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    try {
      await seedClinic(h, { doctors: 1, whatsappPhoneNumberId: PHONE_NUMBER_ID });
      const body = JSON.stringify(whatsappPayload({ phoneNumberId: PHONE_NUMBER_ID, from: SENDER, messageId: 'wamid.s1', text: 'BOOK' }));

      const unsigned = await request(h, 'POST', '/api/webhooks/whatsapp', { rawPayload: body });
      expect(unsigned.statusCode).toBe(401);

      const tampered = await request(h, 'POST', '/api/webhooks/whatsapp', {
        rawPayload: body.replace('BOOK', 'CANCEL'),
        headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}` },
      });
      expect(tampered.statusCode).toBe(401);

      const signed = await request(h, 'POST', '/api/webhooks/whatsapp', {
        rawPayload: body,
        headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}` },
      });
      expect(signed.statusCode).toBe(200);
      expect((await json(signed)).processed).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('answers Meta\'s subscription challenge only with the right verify token', async () => {
    const h = await createHarness({ WHATSAPP_VERIFY_TOKEN: 'verify-me', RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    try {
      const ok = await h.app.inject({
        method: 'GET',
        url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345',
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toBe('12345');

      const wrong = await h.app.inject({
        method: 'GET',
        url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345',
      });
      expect(wrong.statusCode).toBe(403);
    } finally {
      await h.close();
    }
  });

  it('is disabled in production when no app secret is set', async () => {
    const h = await createHarness({
      NODE_ENV: 'production',
      APP_ORIGINS: 'https://app.example.com',
      PUBLIC_API_URL: 'https://api.example.com',
      SIMULATOR_ENABLED: 'false',
      RATE_LIMIT_AUTH_PER_MINUTE: '10000',
    });
    try {
      const response = await request(h, 'POST', '/api/webhooks/whatsapp', {
        body: whatsappPayload({ phoneNumberId: PHONE_NUMBER_ID, from: SENDER, messageId: 'wamid.p1', text: 'BOOK' }),
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await h.close();
    }
  });
});

describeDb('WhatsApp bot edge cases', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
  });
  afterAll(async () => h.close());

  it('says no tokens are open when every doctor is full for tomorrow', async () => {
    const full = await seedClinic(h, { doctors: 1, capacity: 1, whatsappPhoneNumberId: '777000111' });
    const patientId = (await json(await request(h, 'POST', '/api/patients', { cookie: full.reception, body: { fullName: 'First In' } }))).id;
    const booked = await request(h, 'POST', '/api/tokens', {
      cookie: full.reception,
      body: { doctorId: full.doctors[0]!.id, date: TOMORROW, source: 'phone', patient: { patientId }, notifyPatient: false },
    });
    expect(booked.statusCode).toBe(201);

    await inbound(h, { id: 'wamid.f1', from: '919811100020', text: 'BOOK', phoneNumberId: '777000111' });
    await inbound(h, { id: 'wamid.f1l', from: '919811100020', text: '1', phoneNumberId: '777000111' });
    await inbound(h, { id: 'wamid.f2', from: '919811100020', text: 'Full House', phoneNumberId: '777000111' });
    await inbound(h, { id: 'wamid.f3', from: '919811100020', text: '40', phoneNumberId: '777000111' });
    await inbound(h, { id: 'wamid.f4', from: '919811100020', text: 'yes', phoneNumberId: '777000111' });
    await expectReply(h, 'No tokens are open for 31/10/2026');
  });

  it('says the clinic is closed when tomorrow is a holiday', async () => {
    const closed = await seedClinic(h, { doctors: 1, capacity: 3, whatsappPhoneNumberId: '888000222' });
    await request(h, 'POST', '/api/holidays', { cookie: closed.owner, body: { date: TOMORROW } });
    await inbound(h, { id: 'wamid.h1', from: '919811100021', text: 'BOOK', phoneNumberId: '888000222' });
    await inbound(h, { id: 'wamid.h1l', from: '919811100021', text: '1', phoneNumberId: '888000222' });
    await inbound(h, { id: 'wamid.h2', from: '919811100021', text: 'Holiday Patient', phoneNumberId: '888000222' });
    await inbound(h, { id: 'wamid.h3', from: '919811100021', text: '40', phoneNumberId: '888000222' });
    await inbound(h, { id: 'wamid.h4', from: '919811100021', text: 'yes', phoneNumberId: '888000222' });
    await expectReply(h, 'The clinic is closed on 31/10/2026');
  });

  it('rejects a name that is clearly not a name and keeps the patient in the same step', async () => {
    await seedClinic(h, { doctors: 1, capacity: 3, whatsappPhoneNumberId: '555123123' });
    await inbound(h, { id: 'wamid.n1', from: '919811100022', text: 'BOOK', phoneNumberId: '555123123' });
    await inbound(h, { id: 'wamid.n2', from: '919811100022', text: '1', phoneNumberId: '555123123' });
    await inbound(h, { id: 'wamid.n3', from: '919811100022', text: '12345 !!', phoneNumberId: '555123123' });
    await expectReply(h, 'Please send a valid name');
    const { rows } = await h.pool.query(`SELECT state FROM whatsapp_conversations WHERE state = 'await_name'`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('asks again for a valid age, and creates no patient when the sender declines the number', async () => {
    const declined = await seedClinic(h, { doctors: 1, capacity: 3, whatsappPhoneNumberId: '333444555' });
    const from = '919811100040';
    await inbound(h, { id: 'wamid.d1', from, text: 'book a token', phoneNumberId: '333444555' });
    await inbound(h, { id: 'wamid.d1l', from, text: '1', phoneNumberId: '333444555' });
    await inbound(h, { id: 'wamid.d2', from, text: 'Declined Person', phoneNumberId: '333444555' });
    await inbound(h, { id: 'wamid.d3', from, text: 'thirty', phoneNumberId: '333444555' });
    await expectReply(h, 'Please send the age in years');
    await inbound(h, { id: 'wamid.d4', from, text: '40', phoneNumberId: '333444555' });
    await inbound(h, { id: 'wamid.d5', from, text: 'NO', phoneNumberId: '333444555' });
    await expectReply(h, 'No problem. Please visit or call the clinic');

    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM patients WHERE clinic_id = $1 AND full_name = 'Declined Person'`,
      [declined.clinicId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('stores the clinic’s WhatsApp number for the booking link, and refuses a number without the country code', async () => {
    const owned = await seedClinic(h, { doctors: 1, capacity: 3 });
    const saved = await request(h, 'PATCH', '/api/clinic', { cookie: owned.owner, body: { whatsappDisplayNumber: '+919811100099' } });
    expect(saved.statusCode).toBe(200);
    expect(await json(saved)).toMatchObject({ whatsappDisplayNumber: '+919811100099' });

    const bad = await request(h, 'PATCH', '/api/clinic', { cookie: owned.owner, body: { whatsappDisplayNumber: '9811100099' } });
    expect(bad.statusCode).toBe(400);
  });

  it('offers every day inside the clinic’s booking window, and books the day the patient picks', async () => {
    const windowed = await seedClinic(h, { doctors: 1, capacity: 5, whatsappPhoneNumberId: '666777888' });
    const patch = await request(h, 'PATCH', '/api/clinic', { cookie: windowed.owner, body: { bookingWindowDays: 3 } });
    expect(patch.statusCode).toBe(200);

    const from = '919811100060';
    const pn = '666777888';
    await inbound(h, { id: 'wamid.w1', from, text: 'BOOK', phoneNumberId: pn });
    await inbound(h, { id: 'wamid.w2', from, text: '1', phoneNumberId: pn });
    await inbound(h, { id: 'wamid.w3', from, text: 'Window Patient', phoneNumberId: pn });
    await inbound(h, { id: 'wamid.w4', from, text: '40', phoneNumberId: pn });
    await inbound(h, { id: 'wamid.w5', from, text: 'YES', phoneNumberId: pn });
    await expectReply(h, '2. 01/11/2026');
    await expectReply(h, '3. 02/11/2026');

    await inbound(h, { id: 'wamid.w6', from, text: '2', phoneNumberId: pn });
    await expectReply(h, '1. Dr. Dr Doctor1');
    await inbound(h, { id: 'wamid.w7', from, text: '1', phoneNumberId: pn });
    await expectReply(h, 'Token #1 is booked with Dr. Dr Doctor1 on 01/11/2026');

    const { rows } = await h.pool.query(
      `SELECT t.service_date FROM tokens t JOIN patients p ON p.id = t.patient_id
        WHERE p.full_name = 'Window Patient' AND p.clinic_id = $1`,
      [windowed.clinicId],
    );
    expect(rows[0].service_date).toBe('2026-11-01');
  });

  it('greets a patient the reception already registered by name and goes straight to the doctors', async () => {
    const known = await seedClinic(h, { doctors: 1, capacity: 3, whatsappPhoneNumberId: '444555666' });
    const created = await request(h, 'POST', '/api/patients', {
      cookie: known.reception,
      body: { fullName: 'Sunita Devi', phone: '+919811100030' },
    });
    expect(created.statusCode).toBe(201);

    await inbound(h, { id: 'wamid.k1', from: '919811100030', text: 'hi', phoneNumberId: '444555666' });
    await expectReply(h, 'Welcome back, Sunita!');
    await expectReply(h, 'Reply with the number of the doctor');
  });
});
