import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { isoDate, uuidParam } from '../../lib/schemas.js';
import { normalizePhone } from '../../lib/phone.js';
import { errors } from '../../lib/errors.js';
import { bookTokenForStaff } from './booking.js';
import { applyReceptionAction, callNextPatient, completeToken, getDoctorQueue, getQueueSummary, toTokenDto } from './service.js';
import { getClinicById } from '../clinic/service.js';
import { dateInTimeZone } from '../../lib/clinic-time.js';

const patientRef = z.union([
  z.object({ patientId: z.uuid() }),
  z.object({
    fullName: z.string().trim().min(1).max(160),
    // A new patient needs a phone number: reminders, confirmations and the diary depend on it.
    phone: z.string().trim().min(6, 'Phone number is required').max(25),
    gender: z.enum(['male', 'female', 'other']).nullable().optional(),
    ageYears: z.number().int().min(0).max(130).nullable().optional(),
  }),
]);

const bookBody = z.object({
  doctorId: z.uuid(),
  date: isoDate,
  source: z.enum(['phone', 'walk_in']),
  patient: patientRef,
  notifyPatient: z.boolean().default(true),
});

const queueQuery = z.object({ doctorId: z.uuid(), date: isoDate });
const summaryQuery = z.object({ date: isoDate });
const callNextBody = z.object({ doctorId: z.uuid(), date: isoDate });

export async function registerTokenRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/api/queue', async (request) => {
    const auth = await requireCapability('queue.view')(request);
    const query = queueQuery.parse(request.query);
    return getDoctorQueue(ctx.pool, ctx.cipher, auth, query.doctorId, query.date);
  });

  app.get('/api/queue/summary', async (request) => {
    const auth = await requireCapability('queue.view')(request);
    const query = summaryQuery.parse(request.query);
    return getQueueSummary(ctx.pool, auth.clinicId, query.date);
  });

  app.post('/api/tokens', async (request, reply) => {
    const auth = await requireCapability('tokens.book')(request);
    const body = bookBody.parse(request.body);
    if ('phone' in body.patient && body.patient.phone && !normalizePhone(body.patient.phone, ctx.config.defaultCountryCode)) {
      throw errors.validation('Enter a valid phone number');
    }
    const result = await bookTokenForStaff(ctx, auth, {
      doctorId: body.doctorId,
      date: body.date,
      source: body.source,
      patient: body.patient,
      notifyPatient: body.notifyPatient,
    });
    return reply.code(201).send({ token: result.token, patientId: result.patientId, notification: result.notification });
  });

  app.post('/api/tokens/:id/check-in', async (request) => {
    const auth = await requireCapability('tokens.reception')(request);
    const { id } = uuidParam.parse(request.params);
    return toTokenDto(await applyReceptionAction(ctx.pool, auth, id, 'check-in'));
  });

  app.post('/api/tokens/:id/no-show', async (request) => {
    const auth = await requireCapability('tokens.reception')(request);
    const { id } = uuidParam.parse(request.params);
    return toTokenDto(await applyReceptionAction(ctx.pool, auth, id, 'no-show'));
  });

  app.post('/api/tokens/:id/cancel', async (request) => {
    const auth = await requireCapability('tokens.reception')(request);
    const { id } = uuidParam.parse(request.params);
    return toTokenDto(await applyReceptionAction(ctx.pool, auth, id, 'cancel'));
  });

  app.post('/api/queue/call-next', async (request) => {
    const auth = await requireCapability('queue.doctor')(request);
    const body = callNextBody.parse(request.body);
    const token = await callNextPatient(ctx.pool, auth, body.doctorId, body.date);
    return { token: token ? toTokenDto(token) : null };
  });

  app.post('/api/tokens/:id/complete', async (request) => {
    const auth = await requireCapability('queue.doctor')(request);
    const { id } = uuidParam.parse(request.params);
    return toTokenDto(await completeToken(ctx.pool, auth, id));
  });

  app.get('/api/clinic/today', async (request) => {
    const auth = await requireCapability('clinic.view')(request);
    const clinic = await getClinicById(ctx.pool, auth.clinicId);
    if (!clinic) throw errors.notFound('Clinic');
    return { date: dateInTimeZone(ctx.now(), clinic.timezone), timezone: clinic.timezone };
  });
}
