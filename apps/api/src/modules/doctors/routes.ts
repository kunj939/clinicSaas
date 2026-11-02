import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { withTransaction } from '../../db/pool.js';
import { isIsoDate } from '../../lib/clinic-time.js';
import { errors } from '../../lib/errors.js';
import { isoDate, timeOfDay, uuidParam } from '../../lib/schemas.js';
import { recordAudit } from '../audit/service.js';
import { availabilityForClinic } from '../tokens/booking.js';

const doctorBody = z.object({
  name: z.string().trim().min(2).max(160),
  specialization: z.string().trim().max(120).nullable().optional(),
});

const doctorPatch = doctorBody
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });

const scheduleDay = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startTime: timeOfDay,
    endTime: timeOfDay,
    maxTokens: z.number().int().min(1).max(500),
    isActive: z.boolean().default(true),
  })
  .refine((day) => day.endTime > day.startTime, { message: 'End time must be after start time', path: ['endTime'] });

const scheduleBody = z.object({
  days: z
    .array(scheduleDay)
    .max(7)
    .refine((days) => new Set(days.map((day) => day.weekday)).size === days.length, {
      message: 'Each weekday can appear only once',
    }),
});

const holidayBody = z.object({
  date: isoDate,
  reason: z.string().trim().max(160).nullable().optional(),
});

const availabilityQuery = z.object({ date: isoDate });

export async function registerDoctorRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/api/doctors', async (request) => {
    const auth = await requireCapability('clinic.view')(request);
    const { rows } = await ctx.pool.query(
      `SELECT d.id, d.name, d.specialization, d.is_active,
              COALESCE(array_agg(s.weekday ORDER BY s.weekday) FILTER (WHERE s.is_active), '{}') AS working_days
         FROM doctors d
         LEFT JOIN doctor_schedules s ON s.doctor_id = d.id
        WHERE d.clinic_id = $1
        GROUP BY d.id
        ORDER BY d.name`,
      [auth.clinicId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      specialization: row.specialization,
      isActive: row.is_active,
      workingDays: row.working_days as number[],
    }));
  });

  app.post('/api/doctors', async (request, reply) => {
    const auth = await requireCapability('doctors.manage')(request);
    const body = doctorBody.parse(request.body);
    const { rows } = await ctx.pool.query(
      `INSERT INTO doctors (clinic_id, name, specialization) VALUES ($1, $2, $3) RETURNING id, name, specialization, is_active`,
      [auth.clinicId, body.name, body.specialization ?? null],
    );
    await recordAudit(ctx.pool, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'doctor.created',
      entityType: 'doctor',
      entityId: rows[0].id,
    });
    return reply.code(201).send({
      id: rows[0].id,
      name: rows[0].name,
      specialization: rows[0].specialization,
      isActive: rows[0].is_active,
      workingDays: [],
    });
  });

  app.patch('/api/doctors/:id', async (request) => {
    const auth = await requireCapability('doctors.manage')(request);
    const { id } = uuidParam.parse(request.params);
    const body = doctorPatch.parse(request.body);
    const { rows } = await ctx.pool.query(
      `UPDATE doctors
          SET name = COALESCE($3, name),
              specialization = CASE WHEN $4::boolean THEN $5 ELSE specialization END,
              is_active = COALESCE($6, is_active)
        WHERE id = $1 AND clinic_id = $2
        RETURNING id, name, specialization, is_active`,
      [
        id,
        auth.clinicId,
        body.name ?? null,
        body.specialization !== undefined,
        body.specialization ?? null,
        body.isActive ?? null,
      ],
    );
    if (!rows[0]) throw errors.notFound('Doctor');
    await recordAudit(ctx.pool, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'doctor.updated',
      entityType: 'doctor',
      entityId: id,
      metadata: { fields: Object.keys(body).join(',') },
    });
    return {
      id: rows[0].id,
      name: rows[0].name,
      specialization: rows[0].specialization,
      isActive: rows[0].is_active,
    };
  });

  app.get('/api/doctors/:id/schedule', async (request) => {
    const auth = await requireCapability('clinic.view')(request);
    const { id } = uuidParam.parse(request.params);
    const { rows } = await ctx.pool.query(
      `SELECT weekday, start_time, end_time, max_tokens, is_active
         FROM doctor_schedules WHERE doctor_id = $1 AND clinic_id = $2 ORDER BY weekday`,
      [id, auth.clinicId],
    );
    return rows.map((row) => ({
      weekday: row.weekday,
      startTime: String(row.start_time).slice(0, 5),
      endTime: String(row.end_time).slice(0, 5),
      maxTokens: row.max_tokens,
      isActive: row.is_active,
    }));
  });

  /** Replaces the whole weekly schedule in one transaction. */
  app.put('/api/doctors/:id/schedule', async (request) => {
    const auth = await requireCapability('schedules.manage')(request);
    const { id } = uuidParam.parse(request.params);
    const body = scheduleBody.parse(request.body);

    await withTransaction(ctx.pool, async (client) => {
      const doctor = await client.query('SELECT 1 FROM doctors WHERE id = $1 AND clinic_id = $2', [id, auth.clinicId]);
      if (!doctor.rowCount) throw errors.notFound('Doctor');
      await client.query('DELETE FROM doctor_schedules WHERE doctor_id = $1', [id]);
      for (const day of body.days) {
        await client.query(
          `INSERT INTO doctor_schedules (clinic_id, doctor_id, weekday, start_time, end_time, max_tokens, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [auth.clinicId, id, day.weekday, day.startTime, day.endTime, day.maxTokens, day.isActive],
        );
      }
      await recordAudit(client, {
        clinicId: auth.clinicId,
        actorUserId: auth.userId,
        action: 'doctor.schedule_replaced',
        entityType: 'doctor',
        entityId: id,
        metadata: { days: body.days.length },
      });
    });
    return { ok: true };
  });

  app.get('/api/doctors/:id/availability', async (request) => {
    const auth = await requireCapability('clinic.view')(request);
    const { id } = uuidParam.parse(request.params);
    const query = availabilityQuery.parse(request.query);
    return availabilityForClinic(ctx, auth.clinicId, id, query.date);
  });

  app.get('/api/holidays', async (request) => {
    const auth = await requireCapability('clinic.view')(request);
    const { rows } = await ctx.pool.query(
      `SELECT id, holiday_date, reason FROM clinic_holidays
        WHERE clinic_id = $1 AND holiday_date >= CURRENT_DATE - 1
        ORDER BY holiday_date`,
      [auth.clinicId],
    );
    return rows.map((row) => ({
      id: row.id,
      date: row.holiday_date,
      reason: row.reason,
    }));
  });

  app.post('/api/holidays', async (request, reply) => {
    const auth = await requireCapability('holidays.manage')(request);
    const body = holidayBody.parse(request.body);
    if (!isIsoDate(body.date)) throw errors.validation('Invalid date');
    const { rows } = await ctx.pool.query(
      `INSERT INTO clinic_holidays (clinic_id, holiday_date, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (clinic_id, holiday_date) DO UPDATE SET reason = EXCLUDED.reason
       RETURNING id, holiday_date, reason`,
      [auth.clinicId, body.date, body.reason ?? null],
    );
    await recordAudit(ctx.pool, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'holiday.saved',
      entityType: 'holiday',
      entityId: rows[0].id,
    });
    return reply.code(201).send({ id: rows[0].id, date: body.date, reason: rows[0].reason });
  });

  app.delete('/api/holidays/:id', async (request, reply) => {
    const auth = await requireCapability('holidays.manage')(request);
    const { id } = uuidParam.parse(request.params);
    const { rowCount } = await ctx.pool.query('DELETE FROM clinic_holidays WHERE id = $1 AND clinic_id = $2', [
      id,
      auth.clinicId,
    ]);
    if (!rowCount) throw errors.notFound('Holiday');
    await recordAudit(ctx.pool, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'holiday.deleted',
      entityType: 'holiday',
      entityId: id,
    });
    return reply.code(204).send();
  });
}
