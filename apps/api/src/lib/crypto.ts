import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 64;

/** Hashes a password with scrypt. Output is self-describing so parameters can be upgraded later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, { ...SCRYPT_PARAMS, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * A real hash of a random secret, created once. Login verifies against it when the email is
 * unknown so response timing does not reveal which accounts exist.
 */
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomToken());
  return dummyHash;
}

/** Constant-time comparison for secrets such as webhook verify tokens. */
export function safeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** URL-safe random secret, e.g. session cookies and report links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Field-level encryption (AES-256-GCM) for personal data, plus a keyed blind index (HMAC)
 * so records can be looked up by value without storing the plain value.
 */
export interface FieldCipher {
  encrypt(plain: string): string;
  decrypt(payload: string): string;
  blindIndex(value: string): string;
}

export function createFieldCipher(keyBase64: string): FieldCipher {
  const masterKey = Buffer.from(keyBase64, 'base64');
  if (masterKey.length !== 32) throw new Error('Field cipher key must be 32 bytes');
  const encKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'clinic:field-encryption', 32));
  const indexKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'clinic:blind-index', 32));

  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
    },
    decrypt(payload) {
      const [version, ivB64, tagB64, dataB64] = payload.split('.');
      if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Unsupported ciphertext format');
      const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB64, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
    },
    blindIndex(value) {
      return createHmac('sha256', indexKey).update(value).digest('hex');
    },
  };
}
