import { z } from 'zod';

/** Accepts the strings "true" / "false" from environment variables. */
const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default('0.0.0.0'),
    TRUST_PROXY: flag('true'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_SSL: flag('false'),
    DATABASE_SSL_REJECT_UNAUTHORIZED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    /** Comma-separated list of frontend origins allowed to call the API with cookies. */
    APP_ORIGINS: z.string().default('http://localhost:5173'),
    /** Public URL of this API (used to build secure report links). */
    PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
    /** Public URL of the static frontend. */
    PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
    COOKIE_DOMAIN: z.string().optional(),

    /** 32-byte random key, base64 encoded. Encrypts phone numbers and message bodies. */
    DATA_ENCRYPTION_KEY: z
      .string()
      .min(1, 'DATA_ENCRYPTION_KEY is required')
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'DATA_ENCRYPTION_KEY must be 32 random bytes encoded as base64',
      }),

    MESSAGING_PROVIDER: z.enum(['mock', 'meta']).default('mock'),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_VERIFY_TOKEN: z.string().optional(),
    WHATSAPP_API_VERSION: z.string().default('v21.0'),
    /** Approved utility template with one body variable. Used for notifications sent outside the 24h window. */
    WHATSAPP_NOTIFICATION_TEMPLATE: z.string().optional(),
    WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en'),

    /** PayU merchant credentials. Leave empty to keep online payments off. */
    PAYU_MERCHANT_KEY: z.string().trim().optional(),
    PAYU_MERCHANT_SALT: z.string().trim().optional(),
    PAYU_ENV: z.enum(['test', 'production']).default('test'),

    /** Enables the staff WhatsApp simulator. Defaults to on for the mock provider outside production. */
    SIMULATOR_ENABLED: z.enum(['true', 'false']).optional(),
    WORKER_ENABLED: flag('true'),
    OUTBOX_POLL_MS: z.coerce.number().int().min(250).default(5000),

    DEFAULT_COUNTRY_CODE: z.string().regex(/^\d{1,3}$/).default('91'),
    REPORT_LINK_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
    REPORT_LINK_MAX_USES: z.coerce.number().int().min(1).max(100).default(10),
    RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
    MAX_REPORT_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(20 * 1024 * 1024)
      .default(5 * 1024 * 1024),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.APP_ORIGINS.includes('localhost')) {
        ctx.addIssue({ code: 'custom', path: ['APP_ORIGINS'], message: 'Set APP_ORIGINS to the production frontend URL' });
      }
      if (!env.PUBLIC_API_URL.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_API_URL'], message: 'PUBLIC_API_URL must use https in production' });
      }
    }
    if (Boolean(env.PAYU_MERCHANT_KEY) !== Boolean(env.PAYU_MERCHANT_SALT)) {
      ctx.addIssue({ code: 'custom', path: ['PAYU_MERCHANT_SALT'], message: 'Set both PAYU_MERCHANT_KEY and PAYU_MERCHANT_SALT, or neither' });
    }
    if (env.MESSAGING_PROVIDER === 'meta') {
      for (const key of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'] as const) {
        if (!env[key]) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when MESSAGING_PROVIDER=meta` });
        }
      }
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  trustProxy: boolean;
  logLevel: string;
  databaseUrl: string;
  databaseSsl: boolean;
  databaseSslRejectUnauthorized: boolean;
  databasePoolMax: number;
  appOrigins: string[];
  publicApiUrl: string;
  publicAppUrl: string;
  cookieDomain: string | undefined;
  dataEncryptionKey: string;
  messagingProvider: 'mock' | 'meta';
  whatsapp: {
    accessToken: string | undefined;
    appSecret: string | undefined;
    verifyToken: string | undefined;
    apiVersion: string;
    notificationTemplate: string | undefined;
    templateLanguage: string;
  };
  payu: {
    key: string | undefined;
    salt: string | undefined;
    env: 'test' | 'production';
  };
  simulatorEnabled: boolean;
  workerEnabled: boolean;
  outboxPollMs: number;
  defaultCountryCode: string;
  reportLinkTtlHours: number;
  reportLinkMaxUses: number;
  maxReportBytes: number;
  authRateLimitPerMinute: number;
}

/** Parses and validates process configuration. Throws with a readable message on invalid input. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;
  const simulatorEnabled =
    e.SIMULATOR_ENABLED !== undefined ? e.SIMULATOR_ENABLED === 'true' : e.MESSAGING_PROVIDER === 'mock' && e.NODE_ENV !== 'production';

  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    port: e.PORT,
    host: e.HOST,
    trustProxy: e.TRUST_PROXY,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'production' ? 'info' : 'debug'),
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    databaseSslRejectUnauthorized: e.DATABASE_SSL_REJECT_UNAUTHORIZED,
    databasePoolMax: e.DATABASE_POOL_MAX,
    appOrigins: e.APP_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/$/, ''),
    publicAppUrl: e.PUBLIC_APP_URL.replace(/\/$/, ''),
    cookieDomain: e.COOKIE_DOMAIN || undefined,
    dataEncryptionKey: e.DATA_ENCRYPTION_KEY,
    messagingProvider: e.MESSAGING_PROVIDER,
    whatsapp: {
      accessToken: e.WHATSAPP_ACCESS_TOKEN,
      appSecret: e.WHATSAPP_APP_SECRET,
      verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      apiVersion: e.WHATSAPP_API_VERSION,
      notificationTemplate: e.WHATSAPP_NOTIFICATION_TEMPLATE,
      templateLanguage: e.WHATSAPP_TEMPLATE_LANGUAGE,
    },
    payu: { key: e.PAYU_MERCHANT_KEY || undefined, salt: e.PAYU_MERCHANT_SALT || undefined, env: e.PAYU_ENV },
    simulatorEnabled,
    workerEnabled: e.WORKER_ENABLED,
    outboxPollMs: e.OUTBOX_POLL_MS,
    defaultCountryCode: e.DEFAULT_COUNTRY_CODE,
    reportLinkTtlHours: e.REPORT_LINK_TTL_HOURS,
    reportLinkMaxUses: e.REPORT_LINK_MAX_USES,
    maxReportBytes: e.MAX_REPORT_BYTES,
    authRateLimitPerMinute: e.RATE_LIMIT_AUTH_PER_MINUTE,
  };
}
