import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createFieldCipher, hashPassword, randomToken, safeEqualStrings, sha256Hex, verifyPassword } from '../../src/lib/crypto.js';
import { normalizePhone, maskPhone } from '../../src/lib/phone.js';
import { addDays, dateInTimeZone, formatDisplayDate, isIsoDate, periodOf, timeInTimeZone, weekdayOf } from '../../src/lib/clinic-time.js';
import { can, ROLES } from '../../src/lib/permissions.js';
import { catalog, detectLang, LANGUAGES, languageMenu, render, type TemplateKey } from '../../src/modules/messaging/templates.js';
import { detectReportMime } from '../../src/modules/reports/service.js';
import { verifyMetaSignature } from '../../src/modules/whatsapp/webhook.js';
import { createMetaAdapter, toTemplateParameter, ProviderError } from '../../src/modules/messaging/adapters.js';
import { describeSendError } from '../../src/modules/messaging/outbox.js';
import { createHmac } from 'node:crypto';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('phone normalisation', () => {
  it('adds the default country code to local numbers', () => {
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    expect(normalizePhone('09876543210')).toBe('+919876543210');
  });

  it('accepts international formats and rejects junk', () => {
    expect(normalizePhone('+1 (415) 555-2671')).toBe('+14155552671');
    expect(normalizePhone('0091 9876543210')).toBe('+919876543210');
    expect(normalizePhone('919876543210')).toBe('+919876543210');
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('+0123')).toBeNull();
    expect(normalizePhone('12')).toBeNull();
  });

  it('masks all but the last four digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
  });
});

describe('clinic time helpers', () => {
  it('uses the clinic timezone for "today" near midnight', () => {
    // 19:00 UTC on 30 Oct is already 31 Oct in India (UTC+5:30).
    const instant = new Date('2026-10-30T19:00:00Z');
    expect(dateInTimeZone(instant, 'Asia/Kolkata')).toBe('2026-10-31');
    expect(dateInTimeZone(instant, 'UTC')).toBe('2026-10-30');
  });

  it('reports local wall-clock time for cut-off checks', () => {
    expect(timeInTimeZone(new Date('2026-10-30T14:31:00Z'), 'Asia/Kolkata')).toBe('20:01');
  });

  it('does plain calendar arithmetic across month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('computes weekday in a timezone-independent way', () => {
    expect(weekdayOf('2026-10-30')).toBe(5); // Friday
    expect(weekdayOf('2026-11-01')).toBe(0); // Sunday
  });

  it('validates ISO dates strictly', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('30/10/2026')).toBe(false);
  });

  it('formats dates and periods for messages and quotas', () => {
    expect(formatDisplayDate('2026-10-05')).toBe('05/10/2026');
    expect(periodOf('2026-10-05')).toBe('2026-10');
  });
});

describe('crypto', () => {
  it('hashes and verifies passwords without storing the plain value', async () => {
    const hash = await hashPassword('Correct-Horse-1');
    expect(hash).not.toContain('Correct-Horse-1');
    expect(await verifyPassword('Correct-Horse-1', hash)).toBe(true);
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('encrypts fields with a fresh nonce and decrypts them back', () => {
    const cipher = createFieldCipher(KEY);
    const a = cipher.encrypt('+919876543210');
    const b = cipher.encrypt('+919876543210');
    expect(a).not.toBe(b);
    expect(a).not.toContain('9876543210');
    expect(cipher.decrypt(a)).toBe('+919876543210');
  });

  it('rejects tampered ciphertext', () => {
    const cipher = createFieldCipher(KEY);
    const payload = cipher.encrypt('secret');
    const [version, iv, tag, data] = payload.split('.');
    const flipped = `${version}.${iv}.${tag}.${data!.slice(0, -2)}AA`;
    expect(() => cipher.decrypt(flipped)).toThrow();
  });

  it('produces a stable blind index that depends on the key', () => {
    const cipher = createFieldCipher(KEY);
    const other = createFieldCipher(Buffer.alloc(32, 9).toString('base64'));
    expect(cipher.blindIndex('+919876543210')).toBe(cipher.blindIndex('+919876543210'));
    expect(cipher.blindIndex('+919876543210')).not.toBe(other.blindIndex('+919876543210'));
  });

  it('compares secrets in constant time and hashes deterministically', () => {
    expect(safeEqualStrings('abc', 'abc')).toBe(true);
    expect(safeEqualStrings('abc', 'abd')).toBe(false);
    expect(safeEqualStrings('abc', 'abcd')).toBe(false);
    expect(sha256Hex('x')).toHaveLength(64);
    expect(randomToken(32)).not.toBe(randomToken(32));
  });
});

describe('webhook signature', () => {
  it('accepts only the exact body signed with the app secret', () => {
    const body = '{"entry":[]}';
    const secret = 'app-secret';
    const header = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, header, secret)).toBe(true);
    expect(verifyMetaSignature(body + ' ', header, secret)).toBe(false);
    expect(verifyMetaSignature(body, header, 'other')).toBe(false);
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', secret)).toBe(false);
  });
});

describe('report file type detection', () => {
  it('detects PDF, JPEG and PNG by magic bytes', () => {
    expect(detectReportMime(Buffer.from('%PDF-1.7 rest'))).toBe('application/pdf');
    expect(detectReportMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(detectReportMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
  });

  it('rejects anything else, including an executable renamed to .pdf', () => {
    expect(detectReportMime(Buffer.from('MZ\x90\x00 executable'))).toBeNull();
    expect(detectReportMime(Buffer.from('<html><script>'))).toBeNull();
    expect(detectReportMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('permissions', () => {
  it('keeps owner-only actions away from reception and doctors', () => {
    for (const capability of ['doctors.manage', 'schedules.manage', 'holidays.manage', 'staff.manage', 'audit.view'] as const) {
      expect(can('owner', capability)).toBe(true);
      expect(can('receptionist', capability)).toBe(false);
      expect(can('doctor', capability)).toBe(false);
    }
  });

  it('lets doctors upload reports but not book tokens', () => {
    expect(can('doctor', 'reports.upload')).toBe(true);
    expect(can('doctor', 'tokens.book')).toBe(false);
    expect(ROLES).toEqual(['owner', 'receptionist', 'doctor']);
  });
});

describe('message templates', () => {
  it('uses the same placeholders as English in every translation, and Hindi covers every key', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const key of Object.keys(catalog.en) as TemplateKey[]) {
      expect(placeholders(catalog.hi[key] ?? ''), key).toBe(placeholders(catalog.en[key] ?? ''));
    }
    expect(Object.keys(catalog.hi).sort()).toEqual(Object.keys(catalog.en).sort());
    for (const lang of LANGUAGES) {
      for (const [key, text] of Object.entries(catalog[lang])) {
        expect(placeholders(text ?? ''), `${lang} ${key}`).toBe(placeholders(catalog.en[key as TemplateKey] ?? ''));
      }
    }
  });

  it('offers every language in the menu, numbered in order', () => {
    const menu = languageMenu().split('\n');
    expect(menu).toHaveLength(LANGUAGES.length);
    expect(menu[0]).toBe('1. English');
    expect(menu[1]).toBe('2. हिन्दी');
  });

  it('substitutes variables and leaves unknown placeholders visible', () => {
    expect(render('en', 'bot.booked', { clinic: 'Sunrise', token: 4, doctor: 'Rao', date: '31/10/2026' })).toBe(
      'Sunrise: Token #4 is booked with Dr. Rao on 31/10/2026. Reply STATUS to check anytime.',
    );
    expect(render('en', 'bot.booked', { clinic: 'Sunrise' })).toContain('{token}');
  });

  it('detects Hindi from Devanagari script and otherwise uses the clinic default', () => {
    expect(detectLang('बुक', 'en')).toBe('hi');
    expect(detectLang('book', 'hi')).toBe('hi');
    expect(detectLang('book', 'en')).toBe('en');
  });
});

describe('Meta adapter', () => {
  it('sends a free-form text reply to the clinic phone number', async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization ?? null });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = createMetaAdapter({ accessToken: 'tok', apiVersion: 'v21.0', templateLanguage: 'en', fetchImpl });
    const result = await adapter.send({ to: '+919876543210', text: 'Hello', kind: 'reply', templateKey: 'bot.help', phoneNumberId: '555' });

    expect(result.providerMessageId).toBe('wamid.1');
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/555/messages');
    expect(calls[0]!.auth).toBe('Bearer tok');
    expect(calls[0]!.body).toMatchObject({ to: '919876543210', type: 'text', text: { body: 'Hello' } });
  });

  it('uses the approved template for notifications and flattens newlines', async () => {
    let payload: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      payload = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.2' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createMetaAdapter({
      accessToken: 'tok',
      apiVersion: 'v21.0',
      notificationTemplate: 'clinic_notice',
      templateLanguage: 'en',
      fetchImpl,
    });
    await adapter.send({ to: '+919876543210', text: 'Line one\nLine two', kind: 'notification', templateKey: 'token_confirmed', phoneNumberId: '555' });
    expect(payload).toMatchObject({
      type: 'template',
      template: { name: 'clinic_notice', components: [{ parameters: [{ text: 'Line one | Line two' }] }] },
    });
  });

  it('reports provider failures without echoing the response body', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message +919876543210' } }), {
        status: 400,
      })) as unknown as typeof fetch;
    const adapter = createMetaAdapter({ accessToken: 'tok', apiVersion: 'v21.0', templateLanguage: 'en', fetchImpl });
    const error = await adapter
      .send({ to: '+919876543210', text: 'x', kind: 'reply', templateKey: 'bot.help', phoneNumberId: '555' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(describeSendError(error)).toBe('provider status=400 code=131047');
    expect(describeSendError(error)).not.toContain('9876');
  });

  it('flattens template parameters for WhatsApp rules', () => {
    expect(toTemplateParameter('a\n\nb    c')).toBe('a | b c');
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgres://x', DATA_ENCRYPTION_KEY: KEY };

  it('applies safe defaults for local development', () => {
    const config = loadConfig({ ...base });
    expect(config.port).toBe(4000);
    expect(config.messagingProvider).toBe('mock');
    expect(config.simulatorEnabled).toBe(true);
    expect(config.appOrigins).toEqual(['http://localhost:5173']);
  });

  it('refuses a short encryption key', () => {
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 random bytes/);
  });

  it('requires WhatsApp credentials when the Meta provider is selected', () => {
    expect(() => loadConfig({ ...base, MESSAGING_PROVIDER: 'meta' })).toThrow(/WHATSAPP_ACCESS_TOKEN/);
  });

  it('enforces production hardening', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/APP_ORIGINS|PUBLIC_API_URL/);
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      APP_ORIGINS: 'https://app.example.com',
      PUBLIC_API_URL: 'https://api.example.com',
    });
    expect(config.simulatorEnabled).toBe(false);
    expect(config.isProduction).toBe(true);
  });
});
