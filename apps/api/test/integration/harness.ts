import { describe } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createFieldCipher, type FieldCipher } from '../../src/lib/crypto.js';
import { createMockAdapter, type MessagingAdapter, type OutboundMessage } from '../../src/modules/messaging/adapters.js';

/** Integration tests need a real PostgreSQL database. They are skipped when TEST_DATABASE_URL is unset. */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const describeDb = TEST_DB_URL ? describe : describe.skip;

export const TEST_KEY = Buffer.alloc(32, 42).toString('base64');
/** 11:30 on Friday 30 Oct 2026 in Asia/Kolkata. Bookings are for Saturday 31 Oct. */
export const FIXED_NOW = new Date('2026-10-30T06:00:00Z');
export const TODAY = '2026-10-30';
export const TOMORROW = '2026-10-31';

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  pool: Pool;
  cipher: FieldCipher;
  config: AppConfig;
  sent: OutboundMessage[];
  setNow(date: Date): void;
  close(): Promise<void>;
}

export async function createHarness(overrides: Record<string, string> = {}, adapter?: MessagingAdapter): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL!,
    DATA_ENCRYPTION_KEY: TEST_KEY,
    APP_ORIGINS: 'http://localhost:5173',
    PUBLIC_API_URL: 'http://localhost:4000',
    WORKER_ENABLED: 'false',
    SIMULATOR_ENABLED: 'true',
    RATE_LIMIT_AUTH_PER_MINUTE: '10000',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
  const pool = createPool(config);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);

  const sent: OutboundMessage[] = [];
  const messaging = adapter ?? createMockAdapter((message) => sent.push(message));
  let clock = FIXED_NOW;
  const ctx: AppContext = {
    config,
    pool,
    cipher: createFieldCipher(config.dataEncryptionKey),
    messaging,
    now: () => clock,
  };
  const app = await buildApp(ctx);
  await app.ready();

  return {
    app,
    ctx,
    pool,
    cipher: ctx.cipher,
    config,
    sent,
    setNow: (date) => {
      clock = date;
    },
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export type Cookie = string;

export async function request(
  h: Harness,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  options: { body?: unknown; cookie?: Cookie; headers?: Record<string, string>; rawPayload?: string | Buffer } = {},
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    payload: options.rawPayload ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...options.headers,
    },
  });
}

export async function json<T = any>(response: LightMyRequestResponse): Promise<T> {
  return response.json() as T;
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}${counter}-${Date.now().toString(36)}@clinic.test`;
}

export const PASSWORD = 'Correct-Horse-1';

export async function signupOwner(h: Harness, email = uniqueEmail('owner')): Promise<Cookie> {
  const response = await request(h, 'POST', '/api/auth/signup', {
    body: { email, password: PASSWORD, fullName: 'Owner Person' },
  });
  if (response.statusCode !== 201) throw new Error(`signup failed: ${response.body}`);
  return cookieFrom(response);
}

export function cookieFrom(response: LightMyRequestResponse): Cookie {
  const cookie = response.cookies.find((c) => c.name === 'dc_session');
  if (!cookie) throw new Error('no session cookie in response');
  return `dc_session=${cookie.value}`;
}

export async function login(h: Harness, email: string, password = PASSWORD): Promise<Cookie> {
  const response = await request(h, 'POST', '/api/auth/login', { body: { email, password } });
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.body}`);
  return cookieFrom(response);
}

export interface SeededClinic {
  owner: Cookie;
  clinicId: string;
  reception: Cookie;
  doctors: { id: string; name: string; cookie: Cookie }[];
}

/**
 * A clinic with the owner, one reception login and doctors. Every weekday has a 10:00-18:00
 * schedule with the given capacity, so any date in tests is bookable unless a test closes it.
 */
export async function seedClinic(
  h: Harness,
  options: { doctors?: number; capacity?: number; whatsappPhoneNumberId?: string; name?: string } = {},
): Promise<SeededClinic> {
  const owner = await signupOwner(h);
  const clinic = await json(
    await request(h, 'POST', '/api/clinic', {
      cookie: owner,
      body: {
        name: options.name ?? 'Sunrise Clinic',
        timezone: 'Asia/Kolkata',
        whatsappPhoneNumberId: options.whatsappPhoneNumberId,
      },
    }),
  );

  const doctors: SeededClinic['doctors'] = [];
  for (let index = 0; index < (options.doctors ?? 1); index += 1) {
    const name = `Dr Doctor${index + 1}`;
    const doctor = await json(await request(h, 'POST', '/api/doctors', { cookie: owner, body: { name, specialization: 'General' } }));
    await request(h, 'PUT', `/api/doctors/${doctor.id}/schedule`, {
      cookie: owner,
      body: {
        days: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startTime: '10:00',
          endTime: '18:00',
          maxTokens: options.capacity ?? 10,
          isActive: true,
        })),
      },
    });
    const login = await createStaffLogin(h, owner, { role: 'doctor', doctorId: doctor.id, fullName: name });
    doctors.push({ id: doctor.id, name, cookie: login });
  }

  const reception = await createStaffLogin(h, owner, { role: 'receptionist', fullName: 'Reception Staff' });
  return { owner, clinicId: clinic.id, reception, doctors };
}

export async function createStaffLogin(
  h: Harness,
  owner: Cookie,
  input: { role: 'receptionist' | 'doctor'; doctorId?: string; fullName?: string },
): Promise<Cookie> {
  const email = uniqueEmail(input.role);
  const created = await request(h, 'POST', '/api/staff', {
    cookie: owner,
    body: { email, fullName: input.fullName ?? 'Staff Member', role: input.role, doctorId: input.doctorId ?? null },
  });
  if (created.statusCode !== 201) throw new Error(`staff create failed: ${created.body}`);
  const { temporaryPassword } = await json(created);
  return login(h, email, temporaryPassword);
}

export async function createPatient(h: Harness, cookie: Cookie, fullName: string, phone?: string): Promise<string> {
  const response = await request(h, 'POST', '/api/patients', { cookie, body: { fullName, phone: phone ?? null } });
  if (response.statusCode !== 201) throw new Error(`patient create failed: ${response.body}`);
  return (await json(response)).id as string;
}

/** A WhatsApp Cloud API webhook payload containing one inbound text message. */
export function whatsappPayload(input: { phoneNumberId: string; from: string; messageId: string; text: string | null }) {
  const message =
    input.text === null
      ? { from: input.from, id: input.messageId, timestamp: '1', type: 'image', image: { id: 'x' } }
      : { from: input.from, id: input.messageId, timestamp: '1', type: 'text', text: { body: input.text } };
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '910000000000', phone_number_id: input.phoneNumberId },
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}
