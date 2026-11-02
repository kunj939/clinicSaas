import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { isoDate, uuidParam } from '../../lib/schemas.js';
import {
  createFollowUp,
  getVisitForToken,
  listFollowUps,
  markFollowUpDone,
  MANUAL_PAYMENT_METHODS,
  recordPayment,
  saveVisit,
  sendFollowUpReminder,
} from './service.js';

const visitBody = z.object({
  diagnosis: z.string().trim().max(2000).nullable().optional(),
  clinicalNotes: z.string().trim().max(10_000).nullable().optional(),
  prescription: z.string().trim().max(5000).nullable().optional(),
  medicineDays: z.number().int().min(1).max(366).nullable().optional(),
  followUpDate: isoDate.nullable().optional(),
});

const paymentBody = z
  .object({
    feeAmount: z.number().int().min(0).max(10_000_000).nullable(),
    amountPaid: z.number().int().min(0).max(10_000_000).nullable(),
    paymentMethod: z.enum(MANUAL_PAYMENT_METHODS).nullable(),
  })
  .refine((body) => body.amountPaid === null || body.amountPaid === 0 || body.paymentMethod !== null, {
    message: 'Choose how the payment was made',
    path: ['paymentMethod'],
  });

const followUpBody = z.object({
  patientId: z.uuid(),
  doctorId: z.uuid(),
  dueDate: isoDate,
  reason: z.string().trim().max(200).nullable().optional(),
});

const followUpQuery = z.object({
  status: z.enum(['open', 'done', 'cancelled', 'all']).default('open'),
  doctorId: z.uuid().optional(),
  dueBefore: isoDate.optional(),
});

export async function registerVisitRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/api/tokens/:id/visit', async (request) => {
    const auth = await requireCapability('visits.write')(request);
    const { id } = uuidParam.parse(request.params);
    return getVisitForToken(ctx.pool, auth, id);
  });

  app.put('/api/tokens/:id/visit', async (request) => {
    const auth = await requireCapability('visits.write')(request);
    const { id } = uuidParam.parse(request.params);
    const body = visitBody.parse(request.body);
    return saveVisit(ctx.pool, auth, id, body);
  });

  app.put('/api/tokens/:id/payment', async (request) => {
    const auth = await requireCapability('payments.record')(request);
    const { id } = uuidParam.parse(request.params);
    const body = paymentBody.parse(request.body);
    return recordPayment(ctx.pool, auth, id, body);
  });

  app.get('/api/follow-ups', async (request) => {
    const auth = await requireCapability('followups.view')(request);
    const query = followUpQuery.parse(request.query);
    return listFollowUps(ctx.pool, auth, query);
  });

  app.post('/api/follow-ups', async (request, reply) => {
    const auth = await requireCapability('followups.write')(request);
    const body = followUpBody.parse(request.body);
    const id = await createFollowUp(ctx.pool, auth, body);
    return reply.code(201).send({ id });
  });

  app.post('/api/follow-ups/:id/done', async (request) => {
    const auth = await requireCapability('followups.write')(request);
    const { id } = uuidParam.parse(request.params);
    await markFollowUpDone(ctx.pool, auth, id);
    return { ok: true };
  });

  app.post('/api/follow-ups/:id/remind', async (request) => {
    const auth = await requireCapability('followups.write')(request);
    const { id } = uuidParam.parse(request.params);
    const outcome = await sendFollowUpReminder(ctx, auth, id);
    return { outcome };
  });
}
