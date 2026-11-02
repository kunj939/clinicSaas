import type { Db, Pool } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import type { FieldCipher } from '../../lib/crypto.js';
import type { MessagingAdapter } from './adapters.js';
import { ProviderError } from './adapters.js';
import { recordAudit } from '../audit/service.js';

export const MAX_SEND_ATTEMPTS = 6;

export interface EnqueueInput {
  clinicId: string;
  kind: 'reply' | 'notification';
  templateKey: string;
  phone: string;
  text: string;
  /** Same key = same message. Prevents double notifications when an action is retried. */
  dedupeKey?: string;
  /** Accounting period (YYYY-MM) and the clinic's monthly notification quota. */
  period: string;
  quota: number;
}

export type EnqueueResult = 'queued' | 'duplicate' | 'quota_exceeded';

/**
 * Atomically reserves one notification from the clinic's monthly quota. The conditional upsert
 * means concurrent sends cannot exceed the quota.
 */
async function reserveQuota(db: Db, clinicId: string, period: string, quota: number): Promise<boolean> {
  if (quota <= 0) return false;
  const { rowCount } = await db.query(
    `INSERT INTO clinic_message_usage (clinic_id, period, notifications_sent)
     VALUES ($1, $2, 1)
     ON CONFLICT (clinic_id, period) DO UPDATE
        SET notifications_sent = clinic_message_usage.notifications_sent + 1
      WHERE clinic_message_usage.notifications_sent < $3`,
    [clinicId, period, quota],
  );
  return (rowCount ?? 0) > 0;
}

async function releaseQuota(db: Db, clinicId: string, period: string): Promise<void> {
  await db.query(
    `UPDATE clinic_message_usage SET notifications_sent = notifications_sent - 1
      WHERE clinic_id = $1 AND period = $2 AND notifications_sent > 0`,
    [clinicId, period],
  );
}

/**
 * Queues a message for the worker. Must run inside the caller's transaction so a rolled-back
 * business action never leaves a message behind.
 */
export async function enqueueMessage(db: Db, cipher: FieldCipher, input: EnqueueInput): Promise<EnqueueResult> {
  if (input.kind === 'notification') {
    const reserved = await reserveQuota(db, input.clinicId, input.period, input.quota);
    if (!reserved) {
      await recordAudit(db, {
        clinicId: input.clinicId,
        actorUserId: null,
        action: 'messaging.quota_exceeded',
        entityType: 'clinic',
        entityId: input.clinicId,
        metadata: { template: input.templateKey, period: input.period },
      });
      return 'quota_exceeded';
    }
  }

  const { rowCount } = await db.query(
    `INSERT INTO outbound_messages
       (clinic_id, kind, template_key, to_phone_encrypted, body_encrypted, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      input.clinicId,
      input.kind,
      input.templateKey,
      cipher.encrypt(input.phone),
      cipher.encrypt(input.text),
      input.dedupeKey ?? null,
    ],
  );

  if (!rowCount) {
    if (input.kind === 'notification') await releaseQuota(db, input.clinicId, input.period);
    return 'duplicate';
  }
  return 'queued';
}

export interface OutboxDeps {
  pool: Pool;
  cipher: FieldCipher;
  adapter: MessagingAdapter;
  now?: () => Date;
  batchSize?: number;
}

interface ClaimedRow {
  id: string;
  clinic_id: string;
  kind: 'reply' | 'notification';
  template_key: string;
  to_phone_encrypted: string;
  body_encrypted: string;
  attempts: number;
}

/** Claims due messages with SKIP LOCKED so several workers never send the same message. */
export async function processOutboxBatch(deps: OutboxDeps): Promise<{ sent: number; failed: number }> {
  const batchSize = deps.batchSize ?? 20;
  const claimed = await withTransaction(deps.pool, async (client) => {
    const result = await client.query<ClaimedRow>(
      `UPDATE outbound_messages
          SET attempts = attempts + 1,
              next_attempt_at = now() + interval '2 minutes'
        WHERE id IN (
          SELECT id FROM outbound_messages
           WHERE status = 'queued' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, clinic_id, kind, template_key, to_phone_encrypted, body_encrypted, attempts`,
      [batchSize],
    );
    return result.rows;
  });

  let sent = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      const { rows } = await deps.pool.query<{ whatsapp_phone_number_id: string | null }>(
        'SELECT whatsapp_phone_number_id FROM clinics WHERE id = $1',
        [row.clinic_id],
      );
      const result = await deps.adapter.send({
        to: deps.cipher.decrypt(row.to_phone_encrypted),
        text: deps.cipher.decrypt(row.body_encrypted),
        kind: row.kind,
        templateKey: row.template_key,
        phoneNumberId: rows[0]?.whatsapp_phone_number_id ?? null,
      });
      await deps.pool.query(
        `UPDATE outbound_messages
            SET status = 'sent', provider = $2, provider_message_id = $3, sent_at = now(), last_error = NULL
          WHERE id = $1`,
        [row.id, deps.adapter.provider, result.providerMessageId],
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      const giveUp = row.attempts >= MAX_SEND_ATTEMPTS;
      // Exponential backoff: 30s, 60s, 2m, 4m ... capped at one hour.
      const delaySeconds = Math.min(30 * 2 ** (row.attempts - 1), 3600);
      await deps.pool.query(
        `UPDATE outbound_messages
            SET status = $2,
                next_attempt_at = now() + make_interval(secs => $3::int),
                last_error = $4
          WHERE id = $1`,
        [row.id, giveUp ? 'failed' : 'queued', delaySeconds, describeSendError(error)],
      );
    }
  }
  return { sent, failed };
}

/** Error text stored in the outbox. Must not contain message bodies or phone numbers. */
export function describeSendError(error: unknown): string {
  if (error instanceof ProviderError) {
    return `provider status=${error.status ?? 'none'} code=${error.providerCode ?? 'none'}`.slice(0, 200);
  }
  return 'internal send error';
}
