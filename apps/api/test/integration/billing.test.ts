import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, describeDb, json, request, seedClinic, whatsappPayload, type Harness } from './harness.js';

async function bodiesOf(h: Harness): Promise<string[]> {
  const { rows } = await h.pool.query('SELECT body_encrypted FROM outbound_messages');
  return rows.map((row) => h.cipher.decrypt(row.body_encrypted as string));
}

describeDb('one plan with everything included, and a billing term', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
  });
  afterAll(async () => h.close());

  it('tells the clinic its billing term and end date, with no tiers', async () => {
    const clinic = await seedClinic(h, { doctors: 1, capacity: 5 });
    const dto = await json(await request(h, 'GET', '/api/clinic', { cookie: clinic.owner }));
    expect(dto).toMatchObject({ billingTerm: 'monthly', subscriptionEndsAt: null });
    expect(dto).not.toHaveProperty('plan');
    expect(dto).not.toHaveProperty('planLimits');
  });

  it('lets the platform set a six-month commitment and an end date', async () => {
    const clinic = await seedClinic(h, { doctors: 1, capacity: 5 });
    await h.pool.query(`UPDATE clinics SET billing_term = 'six_months', subscription_ends_at = '2027-04-30' WHERE id = $1`, [clinic.clinicId]);
    const dto = await json(await request(h, 'GET', '/api/clinic', { cookie: clinic.owner }));
    expect(dto).toMatchObject({ billingTerm: 'six_months', subscriptionEndsAt: '2027-04-30' });
  });

  it('includes everything: all languages, a week of advance booking, and more than one doctor', async () => {
    const clinic = await seedClinic(h, { doctors: 1, capacity: 5 });
    const languages = await request(h, 'PATCH', '/api/clinic', {
      cookie: clinic.owner,
      body: { enabledLanguages: ['en', 'hi', 'mr', 'gu', 'bn', 'ta', 'te', 'kn', 'pa'] },
    });
    expect(languages.statusCode).toBe(200);

    const window = await request(h, 'PATCH', '/api/clinic', { cookie: clinic.owner, body: { bookingWindowDays: 7 } });
    expect(window.statusCode).toBe(200);

    const second = await request(h, 'POST', '/api/doctors', { cookie: clinic.owner, body: { name: 'Dr Second' } });
    expect(second.statusCode).toBe(201);
  });

  it('keeps the WhatsApp language menu to the languages the clinic chose', async () => {
    const pn = '222333444';
    const clinic = await seedClinic(h, { doctors: 1, capacity: 5, whatsappPhoneNumberId: pn });
    await request(h, 'PATCH', '/api/clinic', { cookie: clinic.owner, body: { enabledLanguages: ['en', 'mr'] } });

    const from = '919811100071';
    const send = (id: string, text: string) =>
      request(h, 'POST', '/api/webhooks/whatsapp', { body: whatsappPayload({ phoneNumberId: pn, from, messageId: id, text }) });
    await send('wamid.pl1', 'BOOK');

    const bodies = await bodiesOf(h);
    expect(bodies.some((body) => body.includes('1. English\n2. मराठी'))).toBe(true);
    expect(bodies.some((body) => body.includes('3. '))).toBe(false);

    await send('wamid.pl2', '2');
    expect((await bodiesOf(h)).some((body) => body.includes('रुग्णाचे पूर्ण नाव पाठवा'))).toBe(true);
  });
});
