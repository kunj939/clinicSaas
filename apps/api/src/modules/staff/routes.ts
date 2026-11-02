import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { hashPassword, randomToken } from '../../lib/crypto.js';
import { email, personName, uuidParam } from '../../lib/schemas.js';
import { AppError, errors, isPgError, PG_UNIQUE_VIOLATION } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';

const createBody = z.object({
  email,
  fullName: personName,
  role: z.enum(['receptionist', 'doctor']),
  doctorId: z.uuid().nullable().optional(),
});

const patchBody = z
  .object({
    fullName: personName.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

export async function registerStaffRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/api/staff', async (request) => {
    const auth = await requireCapability('staff.manage')(request);
    const { rows } = await ctx.pool.query(
      `SELECT id, email, full_name, role, doctor_id, is_active, created_at
         FROM users
        WHERE clinic_id = $1 AND role <> 'owner'
        ORDER BY created_at`,
      [auth.clinicId],
    );
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      doctorId: row.doctor_id,
      isActive: row.is_active,
      createdAt: row.created_at.toISOString(),
    }));
  });

  /** Creates a staff login with a one-time temporary password, returned only in this response. */
  app.post('/api/staff', async (request, reply) => {
    const auth = await requireCapability('staff.manage')(request);
    const body = createBody.parse(request.body);

    if (body.role === 'doctor') {
      const { rowCount } = await ctx.pool.query(
        'SELECT 1 FROM doctors WHERE id = $1 AND clinic_id = $2 AND is_active',
        [body.doctorId, auth.clinicId],
      );
      if (!rowCount) throw new AppError(400, 'doctor_required', 'Choose an active doctor profile for this login');
    }
    const doctorId = body.role === 'doctor' ? body.doctorId! : null;

    const temporaryPassword = randomToken(12);
    const passwordHash = await hashPassword(temporaryPassword);
    try {
      const { rows } = await ctx.pool.query(
        `INSERT INTO users (clinic_id, doctor_id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, full_name, role, doctor_id, is_active, created_at`,
        [auth.clinicId, doctorId, body.email, passwordHash, body.fullName, body.role],
      );
      const row = rows[0];
      await recordAudit(ctx.pool, {
        clinicId: auth.clinicId,
        actorUserId: auth.userId,
        action: 'staff.created',
        entityType: 'user',
        entityId: row.id,
        metadata: { role: body.role },
      });
      return reply.code(201).send({
        user: {
          id: row.id,
          email: row.email,
          fullName: row.full_name,
          role: row.role,
          doctorId: row.doctor_id,
          isActive: row.is_active,
        },
        temporaryPassword,
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) throw errors.conflict('email_taken', 'That email already has an account');
      throw error;
    }
  });

  /** Owner resets a forgotten password. The new temporary password is shown once and every session is ended. */
  app.post('/api/staff/:id/reset-password', async (request) => {
    const auth = await requireCapability('staff.manage')(request);
    const { id } = uuidParam.parse(request.params);
    const temporaryPassword = randomToken(12);
    const { rowCount } = await ctx.pool.query(
      `UPDATE users
          SET password_hash = $3, failed_login_count = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1 AND clinic_id = $2 AND role <> 'owner'`,
      [id, auth.clinicId, await hashPassword(temporaryPassword)],
    );
    if (!rowCount) throw errors.notFound('Staff member');
    await ctx.pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await recordAudit(ctx.pool, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'staff.password_reset',
      entityType: 'user',
      entityId: id,
    });
    return { temporaryPassword };
  });

  app.patch('/api/staff/:id', async (request) => {
    const auth = await requireCapability('staff.manage')(request);
    const { id } = uuidParam.parse(request.params);
    const body = patchBody.parse(request.body);

    const { rows } = await ctx.pool.query(
      `UPDATE users
          SET full_name = COALESCE($3, full_name),
              is_active = COALESCE($4, is_active),
              updated_at = now()
        WHERE id = $1 AND clinic_id = $2 AND role <> 'owner'
        RETURNING id, email, full_name, role, doctor_id, is_active`,
      [id, auth.clinicId, body.fullName ?? null, body.isActive ?? null],
    );
    const row = rows[0];
    if (!row) throw errors.notFound('Staff member');

    if (body.isActive === false) {
      // Deactivating must take effect immediately, not when the session expires.
      await ctx.pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    }
    await recordAudit(ctx.pool, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: body.isActive === undefined ? 'staff.updated' : body.isActive ? 'staff.activated' : 'staff.deactivated',
      entityType: 'user',
      entityId: id,
    });
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      doctorId: row.doctor_id,
      isActive: row.is_active,
    };
  });
}
