import type { AppContext } from '../context.js';
import { getDummyPasswordHash, hashPassword, verifyPassword } from '../lib/crypto.js';
import { AppError, errors, isPgError, PG_UNIQUE_VIOLATION } from '../lib/errors.js';
import { recordAudit } from '../modules/audit/service.js';
import { createSession, deleteSession, type AuthContext } from './session.js';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface SignupInput {
  email: string;
  password: string;
  fullName: string;
}

export async function signup(ctx: AppContext, input: SignupInput): Promise<{ userId: string }> {
  const passwordHash = await hashPassword(input.password);
  try {
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, 'owner') RETURNING id`,
      [input.email, passwordHash, input.fullName],
    );
    const userId = rows[0]!.id;
    await recordAudit(ctx.pool, {
      clinicId: null,
      actorUserId: userId,
      action: 'auth.signup',
      entityType: 'user',
      entityId: userId,
    });
    return { userId };
  } catch (error) {
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      throw errors.conflict('email_taken', 'An account with this email already exists');
    }
    throw error;
  }
}

export async function login(ctx: AppContext, input: { email: string; password: string }): Promise<string> {
  const invalid = () => new AppError(401, 'invalid_credentials', 'Email or password is incorrect');

  const { rows } = await ctx.pool.query<{
    id: string;
    password_hash: string;
    is_active: boolean;
    failed_login_count: number;
    is_locked: boolean;
  }>(
    `SELECT id, password_hash, is_active, failed_login_count, (locked_until IS NOT NULL AND locked_until > now()) AS is_locked
       FROM users WHERE email = $1`,
    [input.email],
  );
  const user = rows[0];

  // Always run one scrypt verification so unknown emails are not faster than known ones.
  const passwordOk = await verifyPassword(input.password, user ? user.password_hash : await getDummyPasswordHash());
  const locked = Boolean(user?.is_locked);

  if (!user || !user.is_active || locked || !passwordOk) {
    if (user && user.is_active && !locked) {
      await ctx.pool.query(
        `UPDATE users
            SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`,
        [user.id, MAX_FAILED_LOGINS, LOCKOUT_MINUTES],
      );
    }
    throw invalid();
  }

  await ctx.pool.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
  const token = await createSession(ctx.pool, user.id);
  await recordAudit(ctx.pool, {
    clinicId: null,
    actorUserId: user.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
  });
  return token;
}

export async function logout(ctx: AppContext, token: string, auth: AuthContext): Promise<void> {
  await deleteSession(ctx.pool, token);
  await recordAudit(ctx.pool, {
    clinicId: auth.clinicId,
    actorUserId: auth.userId,
    action: 'auth.logout',
    entityType: 'user',
    entityId: auth.userId,
  });
}

export async function changePassword(
  ctx: AppContext,
  auth: AuthContext,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const { rows } = await ctx.pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [
    auth.userId,
  ]);
  const ok = rows[0] && (await verifyPassword(input.currentPassword, rows[0].password_hash));
  if (!ok) throw new AppError(400, 'wrong_password', 'Current password is incorrect');

  const newHash = await hashPassword(input.newPassword);
  await ctx.pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [auth.userId, newHash]);
  // Sign out every other session for this user.
  await ctx.pool.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [auth.userId, auth.sessionId]);
  await recordAudit(ctx.pool, {
    clinicId: auth.clinicId,
    actorUserId: auth.userId,
    action: 'auth.password_changed',
    entityType: 'user',
    entityId: auth.userId,
  });
}
