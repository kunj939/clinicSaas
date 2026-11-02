import type { AppConfig } from './config.js';
import type { FieldCipher } from './lib/crypto.js';
import type { MessagingAdapter } from './modules/messaging/adapters.js';
import type { Pool } from './db/pool.js';

/** Shared runtime dependencies. Built once in server.ts (or per test) and passed to every module. */
export interface AppContext {
  config: AppConfig;
  pool: Pool;
  cipher: FieldCipher;
  messaging: MessagingAdapter;
  /** Injectable clock so timezone and cut-off rules can be tested. */
  now: () => Date;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    /** Unparsed JSON body, kept for webhook signature verification. */
    rawBody?: string;
  }
}
