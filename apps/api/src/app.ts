import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { AppContext } from './context.js';
import { sessionHook } from './auth/session.js';
import { AppError } from './lib/errors.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerClinicRoutes } from './modules/clinic/routes.js';
import { registerStaffRoutes } from './modules/staff/routes.js';
import { registerDoctorRoutes } from './modules/doctors/routes.js';
import { registerPatientRoutes } from './modules/patients/routes.js';
import { registerTokenRoutes } from './modules/tokens/routes.js';
import { registerVisitRoutes } from './modules/visits/routes.js';
import { registerDiaryRoutes } from './modules/diary/routes.js';
import { registerPaymentRoutes } from './modules/payments/routes.js';
import { PAYU_CALLBACK_PATH } from './modules/payments/service.js';
import { registerReportRoutes } from './modules/reports/routes.js';
import { registerAuditRoutes } from './modules/audit/routes.js';
import { registerMessagingRoutes } from './modules/messaging/routes.js';
import { registerWhatsappRoutes } from './modules/whatsapp/webhook.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Strips secrets from request logs: report links, query strings (may contain phone numbers). */
function safeUrl(url: string): string {
  return url.replace(/\/api\/public\/(reports|pay)\/[^/?]+/, '/api/public/$1/:token').split('?')[0] ?? '';
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.phone',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req(request) {
          return { method: request.method, url: safeUrl(request.url), remoteAddress: request.ip };
        },
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  app.decorate('ctx', ctx);
  app.decorateRequest('auth', null);
  app.decorateRequest('rawBody', undefined);

  await app.register(helmet, { crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    origin: (origin, callback) => callback(null, !origin || config.appOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.maxReportBytes, files: 1, fields: 5 },
  });
  await app.register(rateLimit, { global: false });

  // Keep the raw JSON body so the WhatsApp webhook can verify Meta's signature.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = text;
    if (!text) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const error = new Error('Malformed JSON body') as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  // PayU posts the payment result back as a form. Parse it into a plain object of strings.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'))));
  });

  // Resolve the session cookie for every request.
  app.addHook('onRequest', sessionHook(ctx.pool));

  // CSRF defence: cookies are SameSite=Lax, and state-changing requests must come from an allowed origin.
  app.addHook('onRequest', async (request) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    // PayU posts the payment result from its own domain. That request has no session and is protected by PayU's hash instead.
    if (request.url.split('?')[0] === PAYU_CALLBACK_PATH) return;
    const origin = request.headers.origin;
    if (origin && !config.appOrigins.includes(origin)) {
      throw new AppError(403, 'bad_origin', 'Request origin is not allowed');
    }
  });

  app.get('/api/health', async () => {
    await ctx.pool.query('SELECT 1');
    return { status: 'ok', messaging: ctx.messaging.provider, simulator: config.simulatorEnabled };
  });

  await registerAuthRoutes(app);
  await registerClinicRoutes(app);
  await registerStaffRoutes(app);
  await registerDoctorRoutes(app);
  await registerPatientRoutes(app);
  await registerTokenRoutes(app);
  await registerVisitRoutes(app);
  await registerDiaryRoutes(app);
  await registerPaymentRoutes(app);
  await registerReportRoutes(app);
  await registerAuditRoutes(app);
  await registerMessagingRoutes(app);
  await registerWhatsappRoutes(app);

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found', message: 'Route not found' }));

  app.setErrorHandler((rawError: unknown, request, reply) => {
    const error = rawError as Error & { statusCode?: number; code?: string };
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'validation_failed',
        message: 'Please check the highlighted fields',
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = (error as { code?: string }).code;
      return reply.code(status).send({
        error: code === 'FST_REQ_FILE_TOO_LARGE' ? 'file_too_large' : 'bad_request',
        message: error.message,
      });
    }
    request.log.error({ err: { name: error.name, message: error.message } }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong. Please try again.' });
  });

  return app;
}
