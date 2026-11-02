import type { Pool } from '../../db/pool.js';
import type { FieldCipher } from '../../lib/crypto.js';
import type { MessagingAdapter } from './adapters.js';
import { processOutboxBatch } from './outbox.js';

export interface WorkerOptions {
  pool: Pool;
  cipher: FieldCipher;
  adapter: MessagingAdapter;
  pollMs: number;
  log: { error: (obj: object, msg: string) => void };
  /** Runs once an hour alongside housekeeping, for jobs such as due follow-up reminders. */
  hourly?: () => Promise<unknown>;
}

const HOUSEKEEPING_EVERY_MS = 60 * 60 * 1000;

/** Removes data that no longer has a purpose: expired sessions and old webhook de-dup records. */
export async function runHousekeeping(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE expires_at < now() - interval \'1 day\'');
  await pool.query('DELETE FROM whatsapp_webhook_events WHERE received_at < now() - interval \'30 days\'');
}

/** Polls the outbox in the API process. Stop it on shutdown and wait for the in-flight batch. */
export function startOutboxWorker(options: WorkerOptions): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<unknown> = Promise.resolve();
  let lastHousekeeping = 0;

  const tick = async () => {
    if (stopped) return;
    inFlight = (async () => {
      try {
        await processOutboxBatch({ pool: options.pool, cipher: options.cipher, adapter: options.adapter });
        if (Date.now() - lastHousekeeping > HOUSEKEEPING_EVERY_MS) {
          lastHousekeeping = Date.now();
          await runHousekeeping(options.pool);
          await options.hourly?.();
        }
      } catch (error) {
        options.log.error({ err: (error as Error).message }, 'outbox worker tick failed');
      }
    })();
    await inFlight;
    if (!stopped) timer = setTimeout(tick, options.pollMs);
  };

  timer = setTimeout(tick, options.pollMs);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
