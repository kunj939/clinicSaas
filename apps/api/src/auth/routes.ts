import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { email, personName } from '../lib/schemas.js';
import { requireAuth } from './guards.js';
import { clearSessionCookie, resolveSession, SESSION_COOKIE, setSessionCookie, type AuthContext } from './session.js';
import { changePassword, login, logout, signup } from './service.js';
import { getClinicById, toClinicDto } from '../modules/clinic/service.js';
import type { AppContext } from '../context.js';

const passwordSchema = z.string().min(10, 'Use at least 10 characters').max(200);

const signupBody = z.object({
  email,
  password: passwordSchema,
  fullName: personName,
});

const loginBody = z.object({
  email,
  password: z.string().min(1).max(200),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export async function currentUserPayload(ctx: AppContext, auth: AuthContext) {
  const clinic = auth.clinicId ? await getClinicById(ctx.pool, auth.clinicId) : null;
  return {
    user: {
      id: auth.userId,
      email: auth.email,
      fullName: auth.fullName,
      role: auth.role,
      doctorId: auth.doctorId,
    },
    clinic: clinic ? toClinicDto(clinic) : null,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  const authRateLimit = { rateLimit: { max: ctx.config.authRateLimitPerMinute, timeWindow: '1 minute' } };

  app.post('/api/auth/signup', { config: authRateLimit }, async (request, reply) => {
    const body = signupBody.parse(request.body);
    await signup(ctx, body);
    const token = await login(ctx, { email: body.email, password: body.password });
    setSessionCookie(reply, token, ctx.config);
    const auth = await resolveSession(ctx.pool, token);
    return reply.code(201).send(await currentUserPayload(ctx, auth!));
  });

  app.post('/api/auth/login', { config: authRateLimit }, async (request, reply) => {
    const body = loginBody.parse(request.body);
    const token = await login(ctx, body);
    setSessionCookie(reply, token, ctx.config);
    const auth = await resolveSession(ctx.pool, token);
    return currentUserPayload(ctx, auth!);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (request.auth && token) await logout(ctx, token, request.auth);
    clearSessionCookie(reply, ctx.config);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request) => {
    const auth = await requireAuth(request);
    return currentUserPayload(ctx, auth);
  });

  app.post('/api/auth/change-password', async (request) => {
    const auth = await requireAuth(request);
    const body = changePasswordBody.parse(request.body);
    await changePassword(ctx, auth, body);
    return { ok: true };
  });
}
