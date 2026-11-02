import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createFieldCipher } from './lib/crypto.js';
import { createPool } from './db/pool.js';
import { createMetaAdapter, createMockAdapter } from './modules/messaging/adapters.js';
import { startOutboxWorker } from './modules/messaging/worker.js';
import { sendDueFollowUpReminders } from './modules/visits/service.js';
import type { AppContext } from './context.js';

const config = loadConfig();
const pool = createPool(config);
const cipher = createFieldCipher(config.dataEncryptionKey);

const messaging =
  config.messagingProvider === 'meta'
    ? createMetaAdapter({
        accessToken: config.whatsapp.accessToken!,
        apiVersion: config.whatsapp.apiVersion,
        notificationTemplate: config.whatsapp.notificationTemplate,
        templateLanguage: config.whatsapp.templateLanguage,
      })
    : createMockAdapter();

const ctx: AppContext = { config, pool, cipher, messaging, now: () => new Date() };
const app = await buildApp(ctx);

const worker = config.workerEnabled
  ? startOutboxWorker({
      pool,
      cipher,
      adapter: messaging,
      pollMs: config.outboxPollMs,
      log: app.log,
      hourly: () => sendDueFollowUpReminders(ctx),
    })
  : undefined;

await app.listen({ port: config.port, host: config.host });
app.log.info({ provider: messaging.provider, simulator: config.simulatorEnabled }, 'API listening');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await worker?.stop();
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
