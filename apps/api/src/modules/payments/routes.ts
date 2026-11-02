import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { callbackMessage, createPaymentLink, handlePayuCallback, PAYU_CALLBACK_PATH, renderPaymentPage } from './service.js';

/** The patient-facing pages only need to show our own page and to submit to PayU. */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action https://test.payu.in https://secure.payu.in";

const createBody = z.object({ tokenId: z.uuid() });

export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.post('/api/payments/requests', async (request, reply) => {
    const auth = await requireCapability('payments.record')(request);
    const body = createBody.parse(request.body);
    const link = await createPaymentLink(ctx, auth, body.tokenId);
    return reply.code(201).send(link);
  });

  app.get('/api/public/pay/:token', async (request, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(request.params);
    const result = await renderPaymentPage(ctx, token);
    return reply
      .code(result.status)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', PAGE_CSP)
      .send(result.html);
  });

  app.post(PAYU_CALLBACK_PATH, async (request, reply) => {
    const fields = (request.body ?? {}) as Record<string, string>;
    const outcome = await handlePayuCallback(ctx, fields);
    const result = callbackMessage(outcome);
    return reply
      .code(result.status)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', PAGE_CSP)
      .send(result.html);
  });
}
