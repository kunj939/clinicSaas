import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { normalizePhone } from '../../lib/phone.js';
import { errors } from '../../lib/errors.js';
import { uuidParam } from '../../lib/schemas.js';
import { recordAudit } from '../audit/service.js';
import { createPatient, getPatient, searchPatients, toPatientDto, updatePatient } from './service.js';
import { toTokenDto } from '../tokens/service.js';
import { LANGUAGES } from '../messaging/templates.js';

const patientBody = z.object({
  fullName: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(6).max(25).nullable().optional(),
  gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  ageYears: z.number().int().min(0).max(130).nullable().optional(),
  preferredLanguage: z.enum(LANGUAGES).optional(),
});

const patientPatch = patientBody.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'Nothing to update',
});

const searchQuery = z.object({
  q: z.string().max(80).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function registerPatientRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/api/patients', async (request) => {
    const auth = await requireCapability('patients.view')(request);
    const query = searchQuery.parse(request.query);
    return searchPatients(ctx.pool, ctx.cipher, auth.clinicId, query.q, query.limit, auth.role);
  });

  app.post('/api/patients', async (request, reply) => {
    const auth = await requireCapability('patients.write')(request);
    const body = patientBody.parse(request.body);
    const phone = body.phone ? normalizePhone(body.phone, ctx.config.defaultCountryCode) : null;
    if (body.phone && !phone) throw errors.validation('Enter a valid phone number');

    const row = await createPatient(ctx.pool, ctx.cipher, auth.clinicId, {
      fullName: body.fullName,
      phone,
      gender: body.gender ?? null,
      ageYears: body.ageYears ?? null,
      preferredLanguage: body.preferredLanguage,
    });
    await recordAudit(ctx.pool, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'patient.created',
      entityType: 'patient',
      entityId: row.id,
    });
    return reply.code(201).send(toPatientDto(row, ctx.cipher, auth.role));
  });

  app.get('/api/patients/:id', async (request) => {
    const auth = await requireCapability('patients.view')(request);
    const { id } = uuidParam.parse(request.params);
    const patient = await getPatient(ctx.pool, auth.clinicId, id);

    const { rows: tokens } = await ctx.pool.query(
      `SELECT t.*, d.name AS doctor_name
         FROM tokens t JOIN doctors d ON d.id = t.doctor_id
        WHERE t.clinic_id = $1 AND t.patient_id = $2
        ORDER BY t.service_date DESC, t.token_number DESC
        LIMIT 20`,
      [auth.clinicId, id],
    );
    const { rows: followUps } = await ctx.pool.query(
      `SELECT f.id, f.due_date, f.reason, f.status, d.name AS doctor_name
         FROM follow_ups f JOIN doctors d ON d.id = f.doctor_id
        WHERE f.clinic_id = $1 AND f.patient_id = $2 AND f.status = 'open'
        ORDER BY f.due_date`,
      [auth.clinicId, id],
    );
    const { rows: reports } = await ctx.pool.query(
      `SELECT r.id, r.title, r.status, r.mime_type, r.size_bytes, r.created_at, r.ready_at, d.name AS doctor_name
         FROM reports r JOIN doctors d ON d.id = r.doctor_id
        WHERE r.clinic_id = $1 AND r.patient_id = $2
        ORDER BY r.created_at DESC`,
      [auth.clinicId, id],
    );

    return {
      ...toPatientDto(patient, ctx.cipher, auth.role),
      tokens: tokens.map((row) => ({ ...toTokenDto(row), doctorName: row.doctor_name })),
      openFollowUps: followUps.map((row) => ({
        id: row.id,
        dueDate: row.due_date,
        reason: row.reason,
        doctorName: row.doctor_name,
      })),
      reports: reports.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        doctorName: row.doctor_name,
        createdAt: row.created_at.toISOString(),
        readyAt: row.ready_at?.toISOString() ?? null,
      })),
    };
  });

  app.patch('/api/patients/:id', async (request) => {
    const auth = await requireCapability('patients.write')(request);
    const { id } = uuidParam.parse(request.params);
    const body = patientPatch.parse(request.body);
    const phone =
      body.phone === undefined ? undefined : body.phone ? normalizePhone(body.phone, ctx.config.defaultCountryCode) : null;
    if (body.phone && !phone) throw errors.validation('Enter a valid phone number');

    const row = await updatePatient(ctx.pool, ctx.cipher, auth.clinicId, id, {
      fullName: body.fullName,
      gender: body.gender,
      ageYears: body.ageYears,
      preferredLanguage: body.preferredLanguage,
      phone,
    });
    await recordAudit(ctx.pool, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'patient.updated',
      entityType: 'patient',
      entityId: id,
      metadata: { fields: Object.keys(body).join(',') },
    });
    return toPatientDto(row, ctx.cipher, auth.role);
  });

}
