import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMockAdapter, ProviderError, type MessagingAdapter, type OutboundMessage } from '../../src/modules/messaging/adapters.js';
import { MAX_SEND_ATTEMPTS, processOutboxBatch } from '../../src/modules/messaging/outbox.js';
import { startOutboxWorker } from '../../src/modules/messaging/worker.js';
import { createHarness, createPatient, describeDb, json, request, seedClinic, TOMORROW, type Harness, type SeededClinic } from './harness.js';

async function setQuota(h: Harness, clinicId: string, quota: number): Promise<void> {
  await h.pool.query('UPDATE clinics SET monthly_message_quota = $2 WHERE id = $1', [clinicId, quota]);
}

async function usage(h: Harness, clinicId: string): Promise<number> {
  const { rows } = await h.pool.query(
    `SELECT COALESCE(sum(notifications_sent), 0)::int AS n FROM clinic_message_usage WHERE clinic_id = $1`,
    [clinicId],
  );
  return rows[0].n;
}

describeDb('notification quota and outbox', () => {
  let h: Harness;
  let clinic: SeededClinic;

  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    clinic = await seedClinic(h, { doctors: 1, capacity: 30 });
  });
  afterAll(async () => h.close());

  it('stops notifications exactly at the monthly quota, even under concurrent bookings', async () => {
    await setQuota(h, clinic.clinicId, 5);
    const doctorId = clinic.doctors[0]!.id;
    const patients: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      patients.push(await createPatient(h, clinic.reception, `Quota Patient ${index}`, `+9197000${index.toString().padStart(5, '0')}`));
    }

    const responses = await Promise.all(
      patients.map((patientId) =>
        request(h, 'POST', '/api/tokens', {
          cookie: clinic.reception,
          body: { doctorId, date: TOMORROW, source: 'phone', patient: { patientId }, notifyPatient: true },
        }),
      ),
    );
    const outcomes = await Promise.all(responses.map(async (response) => (await json(response)).notification as string));
    expect(outcomes.filter((outcome) => outcome === 'queued')).toHaveLength(5);
    expect(outcomes.filter((outcome) => outcome === 'quota_exceeded')).toHaveLength(15);

    expect(await usage(h, clinic.clinicId)).toBe(5);
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM outbound_messages WHERE kind = 'notification'`);
    expect(rows[0].n).toBe(5);
    const quotaCheck = await json(await request(h, 'GET', '/api/clinic/usage', { cookie: clinic.owner }));
    expect(quotaCheck).toMatchObject({ notificationsSent: 5, quota: 5 });
  });

  it('delivers queued messages through the adapter and records the provider id', async () => {
    const delivered: OutboundMessage[] = [];
    const adapter = createMockAdapter((message) => delivered.push(message));
    const result = await processOutboxBatch({ pool: h.pool, cipher: h.cipher, adapter, batchSize: 50 });
    expect(result).toEqual({ sent: 5, failed: 0 });
    expect(delivered.every((message) => message.to.startsWith('+91'))).toBe(true);

    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM outbound_messages WHERE status = 'sent' AND provider = 'mock' AND provider_message_id IS NOT NULL`);
    expect(rows[0].n).toBe(5);
  });

  it('retries failed sends with backoff and gives up after the maximum number of attempts', async () => {
    await setQuota(h, clinic.clinicId, 300);
    const patientId = await createPatient(h, clinic.reception, 'Retry Patient', '+919700099999');
    await request(h, 'POST', '/api/tokens', {
      cookie: clinic.reception,
      body: { doctorId: clinic.doctors[0]!.id, date: TOMORROW, source: 'phone', patient: { patientId }, notifyPatient: true },
    });

    const failing: MessagingAdapter = {
      provider: 'meta',
      async send() {
        throw new ProviderError('WhatsApp API responded 500', 500, 1);
      },
    };
    await processOutboxBatch({ pool: h.pool, cipher: h.cipher, adapter: failing });
    const first = await h.pool.query(
      `SELECT status, attempts, last_error, next_attempt_at > now() AS deferred FROM outbound_messages
        WHERE status = 'queued' AND attempts = 1 AND last_error IS NOT NULL`,
    );
    expect(first.rows[0]).toMatchObject({ status: 'queued', attempts: 1, deferred: true });
    expect(first.rows[0].last_error).toBe('provider status=500 code=1');
    expect(first.rows[0].last_error).not.toMatch(/9700099999/);

    for (let attempt = 2; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      await h.pool.query(`UPDATE outbound_messages SET next_attempt_at = now() WHERE status = 'queued' AND attempts < $1`, [MAX_SEND_ATTEMPTS]);
      await processOutboxBatch({ pool: h.pool, cipher: h.cipher, adapter: failing });
    }
    const { rows } = await h.pool.query(`SELECT status, attempts FROM outbound_messages WHERE last_error IS NOT NULL`);
    expect(rows.every((row) => row.status === 'failed' && row.attempts === MAX_SEND_ATTEMPTS)).toBe(true);
  });

  it('sends a follow-up reminder once per due date and does not double-count quota', async () => {
    await setQuota(h, clinic.clinicId, 300);
    const patientId = await createPatient(h, clinic.reception, 'Follow Patient', '+919700088888');
    const created = await request(h, 'POST', '/api/follow-ups', {
      cookie: clinic.doctors[0]!.cookie,
      body: { patientId, doctorId: clinic.doctors[0]!.id, dueDate: '2026-11-05', reason: 'Review BP' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = await json(created);

    const before = await usage(h, clinic.clinicId);
    const first = await json(await request(h, 'POST', `/api/follow-ups/${id}/remind`, { cookie: clinic.doctors[0]!.cookie }));
    const second = await json(await request(h, 'POST', `/api/follow-ups/${id}/remind`, { cookie: clinic.doctors[0]!.cookie }));
    expect(first.outcome).toBe('queued');
    expect(second.outcome).toBe('duplicate');
    expect(await usage(h, clinic.clinicId)).toBe(before + 1);
  });

  it('keeps phone numbers and message bodies encrypted at rest and out of the audit trail', async () => {
    const { rows: patients } = await h.pool.query(`SELECT phone_encrypted, phone_hash FROM patients WHERE phone_encrypted IS NOT NULL`);
    expect(patients.length).toBeGreaterThan(0);
    for (const row of patients) {
      expect(row.phone_encrypted).not.toMatch(/\+?9\d{9}/);
      expect(row.phone_hash).toMatch(/^[a-f0-9]{64}$/);
    }

    const { rows: messages } = await h.pool.query(`SELECT to_phone_encrypted, body_encrypted FROM outbound_messages`);
    for (const row of messages) {
      expect(row.to_phone_encrypted).not.toMatch(/\+?9\d{9}/);
      expect(row.body_encrypted.startsWith('v1.')).toBe(true);
    }

    const { rows: audit } = await h.pool.query(`SELECT metadata::text AS text FROM audit_logs`);
    expect(audit.every((row) => !/\+?9\d{9}/.test(row.text))).toBe(true);
  });

  it('shows staff masked recipients and redacts report links in the message log', async () => {
    const response = await json(await request(h, 'GET', '/api/messages?limit=100', { cookie: clinic.reception }));
    expect(response.length).toBeGreaterThan(0);
    for (const message of response) {
      expect(message.to).toMatch(/^\+91\*{6}\d{4}$/);
      expect(message.body).not.toMatch(/https?:\/\//);
    }
  });
});

describeDb('background worker', () => {
  it('sends queued messages on its own and stops cleanly', async () => {
    const h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    try {
      const staff = await seedClinic(h, { doctors: 1, capacity: 5 });
      const patientId = await createPatient(h, staff.reception, 'Worker Patient', '+919700077777');
      await request(h, 'POST', '/api/tokens', {
        cookie: staff.reception,
        body: { doctorId: staff.doctors[0]!.id, date: TOMORROW, source: 'phone', patient: { patientId }, notifyPatient: true },
      });

      const worker = startOutboxWorker({ pool: h.pool, cipher: h.cipher, adapter: createMockAdapter(), pollMs: 250, log: { error: () => undefined } });
      try {
        await waitFor(async () => {
          const { rows } = await h.pool.query(`SELECT status FROM outbound_messages WHERE kind = 'notification'`);
          return rows[0]?.status === 'sent';
        }, 5_000);
      } finally {
        await worker.stop();
      }
      const { rows } = await h.pool.query(`SELECT status, provider FROM outbound_messages WHERE kind = 'notification'`);
      expect(rows[0]).toEqual({ status: 'sent', provider: 'mock' });
    } finally {
      await h.close();
    }
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met in time');
}

describeDb('mock adapter wiring', () => {
  it('uses the mock provider by default and reports it in health', async () => {
    const h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    try {
      const health = await json(await request(h, 'GET', '/api/health'));
      expect(health).toMatchObject({ status: 'ok', messaging: 'mock', simulator: true });
    } finally {
      await h.close();
    }
  });
});
