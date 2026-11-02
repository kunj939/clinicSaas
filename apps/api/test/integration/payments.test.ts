import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createHarness, createPatient, describeDb, json, request, seedClinic, TODAY, type Harness, type SeededClinic } from './harness.js';

const KEY = 'test-merchant-key';
const SALT = 'test-merchant-salt';
const sha512 = (value: string) => createHash('sha512').update(value, 'utf8').digest('hex');

/** Walk-in with a phone number, called in and completed, so a fee can be entered. Returns the token id. */
async function completedVisit(h: Harness, clinic: SeededClinic, fullName: string, phone: string): Promise<string> {
  const doctor = clinic.doctors[0]!;
  const booked = await json(
    await request(h, 'POST', '/api/tokens', {
      cookie: clinic.reception,
      body: { doctorId: doctor.id, date: TODAY, source: 'walk_in', patient: { fullName, phone }, notifyPatient: false },
    }),
  );
  await request(h, 'POST', '/api/queue/call-next', { cookie: doctor.cookie, body: { doctorId: doctor.id, date: TODAY } });
  await request(h, 'POST', `/api/tokens/${booked.token.id}/complete`, { cookie: doctor.cookie });
  return booked.token.id as string;
}

async function setFee(h: Harness, clinic: SeededClinic, tokenId: string, fee: number): Promise<void> {
  const response = await request(h, 'PUT', `/api/tokens/${tokenId}/payment`, {
    cookie: clinic.reception,
    body: { feeAmount: fee, amountPaid: 0, paymentMethod: null },
  });
  expect(response.statusCode).toBe(200);
}

/** Posts a result the way PayU does, with a reverse hash built from our salt. */
async function postCallback(h: Harness, fields: { txnid: string; amount: string; status: string; email: string; firstname: string }) {
  const hash = sha512(`${SALT}|${fields.status}|||||||||||${fields.email}|${fields.firstname}|Consultation fee|${fields.amount}|${fields.txnid}|${KEY}`);
  const body = new URLSearchParams({
    key: KEY,
    txnid: fields.txnid,
    amount: fields.amount,
    productinfo: 'Consultation fee',
    firstname: fields.firstname,
    email: fields.email,
    status: fields.status,
    mihpayid: '403993715000001',
    hash,
  });
  return h.app.inject({
    method: 'POST',
    url: '/api/payments/payu/callback',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://test.payu.in' },
    payload: body.toString(),
  });
}

describeDb('online payments through PayU', () => {
  let h: Harness;
  let clinic: SeededClinic;
  let ownerEmail: string;

  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000', PAYU_MERCHANT_KEY: KEY, PAYU_MERCHANT_SALT: SALT });
    clinic = await seedClinic(h, { doctors: 1, capacity: 30 });
    const { rows } = await h.pool.query(`SELECT email FROM users WHERE clinic_id = $1 AND role = 'owner'`, [clinic.clinicId]);
    ownerEmail = rows[0].email;
  });
  afterAll(async () => h.close());

  async function linkFor(tokenId: string) {
    const response = await request(h, 'POST', '/api/payments/requests', { cookie: clinic.reception, body: { tokenId } });
    expect(response.statusCode).toBe(201);
    return json(response);
  }

  it('creates a payment link for the amount still due and serves a checkout page that submits to PayU', async () => {
    const tokenId = await completedVisit(h, clinic, 'Online Patient', '+919811100001');
    await setFee(h, clinic, tokenId, 500);

    const link = await linkFor(tokenId);
    expect(link).toMatchObject({ amount: 500 });
    expect(link.payUrl).toContain('/api/public/pay/');

    const page = await h.app.inject({ method: 'GET', url: new URL(link.payUrl).pathname });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain('form-action https://test.payu.in');
    expect(page.body).toContain('action="https://test.payu.in/_payment"');
    const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page.body)?.[1];
    expect(field('amount')).toBe('500.00');
    expect(field('key')).toBe(KEY);
    expect(field('email')).toBe(ownerEmail);
    // The hash PayU checks must match the fields on the page.
    const expected = sha512(`${KEY}|${field('txnid')}|500.00|Consultation fee|Online Patient|${ownerEmail}|||||||||||${SALT}`);
    expect(field('hash')).toBe(expected);
  });

  it('returns 404 for an unknown link and never shows an amount', async () => {
    const page = await h.app.inject({ method: 'GET', url: '/api/public/pay/not-a-real-token-but-long-enough-1234567890' });
    expect(page.statusCode).toBe(404);
    expect(page.body).not.toContain('₹');
  });

  it('adds the amount to the visit once when PayU confirms it, and ignores a repeated callback', async () => {
    const tokenId = await completedVisit(h, clinic, 'Paying Online', '+919811100002');
    await setFee(h, clinic, tokenId, 700);
    const link = await linkFor(tokenId);
    const txnid = (await h.pool.query('SELECT txnid FROM payment_requests WHERE id = $1', [link.id])).rows[0].txnid as string;
    const fields = { txnid, amount: '700.00', status: 'success', email: ownerEmail, firstname: 'Paying Online' };

    const first = await postCallback(h, fields);
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('Payment received');

    const second = await postCallback(h, fields);
    expect(second.statusCode).toBe(200);

    const visit = await h.pool.query('SELECT amount_paid, payment_method FROM visits WHERE token_id = $1', [tokenId]);
    expect(visit.rows[0]).toEqual({ amount_paid: 700, payment_method: 'online' });
    const status = await h.pool.query('SELECT status, gateway_payment_id FROM payment_requests WHERE id = $1', [link.id]);
    expect(status.rows[0]).toEqual({ status: 'paid', gateway_payment_id: '403993715000001' });
  });

  it('refuses a callback whose hash does not match, and changes nothing', async () => {
    const tokenId = await completedVisit(h, clinic, 'Tampered', '+919811100003');
    await setFee(h, clinic, tokenId, 300);
    const link = await linkFor(tokenId);
    const txnid = (await h.pool.query('SELECT txnid FROM payment_requests WHERE id = $1', [link.id])).rows[0].txnid as string;

    // The amount is changed after PayU signed it.
    const forged = await h.app.inject({
      method: 'POST',
      url: '/api/payments/payu/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        key: KEY,
        txnid,
        amount: '3.00',
        productinfo: 'Consultation fee',
        firstname: 'Tampered',
        email: ownerEmail,
        status: 'success',
        hash: sha512(`${SALT}|success|||||||||||${ownerEmail}|Tampered|Consultation fee|300.00|${txnid}|${KEY}`),
      }).toString(),
    });
    expect(forged.statusCode).toBe(400);
    expect(JSON.parse(forged.body).error).toBe('invalid_hash');

    const status = await h.pool.query('SELECT status FROM payment_requests WHERE id = $1', [link.id]);
    expect(status.rows[0].status).toBe('pending');
    const visit = await h.pool.query('SELECT amount_paid FROM visits WHERE token_id = $1', [tokenId]);
    expect(visit.rows[0].amount_paid).toBe(0);
  });

  it('marks a failed payment without adding money', async () => {
    const tokenId = await completedVisit(h, clinic, 'Declined Card', '+919811100004');
    await setFee(h, clinic, tokenId, 200);
    const link = await linkFor(tokenId);
    const txnid = (await h.pool.query('SELECT txnid FROM payment_requests WHERE id = $1', [link.id])).rows[0].txnid as string;

    const result = await postCallback(h, { txnid, amount: '200.00', status: 'failure', email: ownerEmail, firstname: 'Declined Card' });
    expect(result.body).toContain('Payment not completed');
    const status = await h.pool.query('SELECT status FROM payment_requests WHERE id = $1', [link.id]);
    expect(status.rows[0].status).toBe('failed');
    const visit = await h.pool.query('SELECT amount_paid FROM visits WHERE token_id = $1', [tokenId]);
    expect(visit.rows[0].amount_paid).toBe(0);
  });

  it('will not make a link when nothing is due or the patient has no phone number', async () => {
    const paidTokenId = await completedVisit(h, clinic, 'Settled', '+919811100005');
    await setFee(h, clinic, paidTokenId, 100);
    await request(h, 'PUT', `/api/tokens/${paidTokenId}/payment`, {
      cookie: clinic.reception,
      body: { feeAmount: 100, amountPaid: 100, paymentMethod: 'cash' },
    });
    const settled = await request(h, 'POST', '/api/payments/requests', { cookie: clinic.reception, body: { tokenId: paidTokenId } });
    expect(settled.statusCode).toBe(409);
    expect((await json(settled)).error).toBe('nothing_due');

    // A patient registered without a phone number, seen by the doctor.
    const noPhoneId = await createPatient(h, clinic.reception, 'No Phone Patient');
    const doctor = clinic.doctors[0]!;
    const booked = await json(
      await request(h, 'POST', '/api/tokens', {
        cookie: clinic.reception,
        body: { doctorId: doctor.id, date: TODAY, source: 'phone', patient: { patientId: noPhoneId }, notifyPatient: false },
      }),
    );
    await request(h, 'POST', `/api/tokens/${booked.token.id}/check-in`, { cookie: clinic.reception });
    await request(h, 'POST', '/api/queue/call-next', { cookie: doctor.cookie, body: { doctorId: doctor.id, date: TODAY } });
    await request(h, 'POST', `/api/tokens/${booked.token.id}/complete`, { cookie: doctor.cookie });
    await setFee(h, clinic, booked.token.id, 150);
    const noPhone = await request(h, 'POST', '/api/payments/requests', { cookie: clinic.reception, body: { tokenId: booked.token.id } });
    expect(noPhone.statusCode).toBe(409);
    expect((await json(noPhone)).error).toBe('phone_required');
  });
});

describeDb('online payments when PayU is not set up', () => {
  it('says so clearly instead of creating a link that cannot work', async () => {
    const h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    try {
      const clinic = await seedClinic(h, { doctors: 1, capacity: 5 });
      const tokenId = await completedVisit(h, clinic, 'Unconfigured', '+919811100006');
      const response = await request(h, 'POST', '/api/payments/requests', { cookie: clinic.reception, body: { tokenId } });
      expect(response.statusCode).toBe(409);
      expect((await json(response)).error).toBe('payments_not_configured');
    } finally {
      await h.close();
    }
  });
});
