import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';
import type { AppConfig } from '../config.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import type { Role } from '../lib/permissions.js';

export const SESSION_COOKIE = 'dc_session';
export const SESSION_TTL_DAYS = 7;

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  fullName: string;
  role: Role;
  clinicId: string | null;
  doctorId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomToken(32);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, sha256Hex(token), SESSION_TTL_DAYS],
  );
  return token;
}

export async function resolveSession(db: Db, token: string): Promise<AuthContext | null> {
  const { rows } = await db.query<{
    session_id: string;
    user_id: string;
    email: string;
    full_name: string;
    role: Role;
    clinic_id: string | null;
    doctor_id: string | null;
  }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.email, u.full_name, u.role, u.clinic_id, u.doctor_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`,
    [sha256Hex(token)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    clinicId: row.clinic_id,
    doctorId: row.doctor_id,
  };
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256Hex(token)]);
}

function cookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax' as const,
    path: '/',
    domain: config.cookieDomain,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, config: AppConfig): void {
  reply.setCookie(SESSION_COOKIE, token, {
    ...cookieOptions(config),
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

/** Resolves the session cookie on every request. Unauthenticated requests stay anonymous. */
export function sessionHook(db: Db) {
  return async function resolveAuth(request: FastifyRequest): Promise<void> {
    request.auth = null;
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    request.auth = await resolveSession(db, token);
  };
}
