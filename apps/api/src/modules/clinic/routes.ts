import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability, requireRoles } from '../../auth/guards.js';
import { timeOfDay, timeZone } from '../../lib/schemas.js';
import { createClinic, getClinicById, getMessageUsage, setupClinic, toClinicDto, updateClinic } from './service.js';
import { errors } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';
import { LANGUAGES } from '../messaging/templates.js';

const whatsappNumberId = z
  .string()
  .trim()
  .regex(/^\d{6,25}$/, 'Use the numeric phone_number_id from Meta')
  .nullable();

const clinicBody = z.object({
  name: z.string().trim().min(2).max(160),
  address: z.string().trim().max(300).nullable().optional(),
  contactPhone: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((value) => !value || normalizePhone(value) !== null, { message: 'Enter a valid phone number' }),
  timezone: timeZone.optional(),
  defaultLanguage: z.enum(LANGUAGES).optional(),
  bookingCutoffTime: timeOfDay.optional(),
  whatsappPhoneNumberId: whatsappNumberId.optional(),
  followUpLeadDays: z.number().int().min(0).max(30).optional(),
  bookingWindowDays: z.number().int().min(1).max(7).optional(),
  enabledLanguages: z.array(z.enum(LANGUAGES)).min(1).max(9).optional(),
  whatsappDisplayNumber: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'Use the number with country code, for example +919876543210')
    .nullable()
    .optional(),
});

const clinicPatch = clinicBody.partial();

const setupDay = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startTime: timeOfDay,
    endTime: timeOfDay,
    maxTokens: z.number().int().min(1).max(500),
    isActive: z.boolean().default(true),
  })
  .refine((day) => day.endTime > day.startTime, { message: 'End time must be after start time', path: ['endTime'] });

/** One-screen setup for a single-doctor clinic. */
const setupBody = z.object({
  clinicName: z.string().trim().min(2).max(160),
  doctorName: z.string().trim().min(2).max(160),
  defaultLanguage: z.enum(LANGUAGES).optional(),
  bookingCutoffTime: timeOfDay.optional(),
  days: z
    .array(setupDay)
    .min(1)
    .max(7)
    .refine((days) => new Set(days.map((day) => day.weekday)).size === days.length, { message: 'Each weekday can appear only once' }),
});

export async function registerClinicRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.post('/api/clinic', async (request, reply) => {
    const auth = await requireRoles('owner')(request);
    const body = clinicBody.parse(request.body);
    const clinic = await createClinic(ctx.pool, auth, {
      ...body,
      contactPhone: body.contactPhone ? normalizePhone(body.contactPhone, ctx.config.defaultCountryCode) : null,
    });
    return reply.code(201).send(toClinicDto(clinic));
  });

  app.post('/api/clinic/setup', async (request, reply) => {
    const auth = await requireRoles('owner')(request);
    const body = setupBody.parse(request.body);
    const clinic = await setupClinic(ctx.pool, auth, {
      clinic: { name: body.clinicName, defaultLanguage: body.defaultLanguage, bookingCutoffTime: body.bookingCutoffTime },
      doctorName: body.doctorName,
      days: body.days,
    });
    return reply.code(201).send(toClinicDto(clinic));
  });

  app.get('/api/clinic', async (request) => {
    const auth = await requireCapability('clinic.view')(request);
    const clinic = await getClinicById(ctx.pool, auth.clinicId);
    if (!clinic) throw errors.notFound('Clinic');
    return toClinicDto(clinic);
  });

  app.patch('/api/clinic', async (request) => {
    const auth = await requireCapability('clinic.manage')(request);
    const body = clinicPatch.parse(request.body);
    const clinic = await updateClinic(ctx.pool, auth, {
      ...body,
      contactPhone:
        body.contactPhone === undefined
          ? undefined
          : body.contactPhone
            ? normalizePhone(body.contactPhone, ctx.config.defaultCountryCode)
            : null,
    });
    return toClinicDto(clinic);
  });

  app.get('/api/clinic/usage', async (request) => {
    const auth = await requireCapability('messages.view')(request);
    const clinic = await getClinicById(ctx.pool, auth.clinicId);
    if (!clinic) throw errors.notFound('Clinic');
    return getMessageUsage(ctx.pool, auth.clinicId, clinic, ctx.now());
  });
}
