import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { withTransaction } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { maskPhone, normalizePhone } from '../../lib/phone.js';
import { recordAudit } from '../audit/service.js';
import { handleInbound } from '../whatsapp/bot.js';

const listQuery = z.object({
  status: z.enum(['queued', 'sent', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const simulateBody = z.object({
  phone: z.string().trim().min(6).max(25),
  text: z.string().max(1000),
});

/** Links are bearer secrets. Staff see that a link was sent, not the link itself. */
export function redactLinks(body: string): string {
  return body.replace(/https?:\/\/\S+/g, '[secure link]');
}

export async function registerMessagingRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/api/messages', async (request) => {
    const auth = await requireCapability('messages.view')(request);
    const query = listQuery.parse(request.query);
    const { rows } = await ctx.pool.query(
      `SELECT id, kind, template_key, to_phone_encrypted, body_encrypted, status, attempts, last_error,
              provider, created_at, sent_at
         FROM outbound_messages
        WHERE clinic_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [auth.clinicId, query.status ?? null, query.limit],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      templateKey: row.template_key,
      to: maskPhone(ctx.cipher.decrypt(row.to_phone_encrypted)),
      body: redactLinks(ctx.cipher.decrypt(row.body_encrypted)),
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
      provider: row.provider,
      createdAt: row.created_at.toISOString(),
      sentAt: row.sent_at?.toISOString() ?? null,
    }));
  });

  /**
   * Staff simulator: runs a patient message through the same bot as the WhatsApp webhook.
   * Only available when SIMULATOR_ENABLED is on (default: mock provider outside production).
   */
  app.post('/api/messages/simulate-inbound', async (request, reply) => {
    if (!ctx.config.simulatorEnabled) throw errors.notFound('Route');
    const auth = await requireCapability('messages.simulate')(request);
    const body = simulateBody.parse(request.body);
    const phone = normalizePhone(body.phone, ctx.config.defaultCountryCode);
    if (!phone) throw errors.validation('Enter a valid phone number');

    await withTransaction(ctx.pool, async (client) => {
      await handleInbound(ctx, client, {
        clinicId: auth.clinicId,
        phone,
        text: body.text.trim() ? body.text : null,
        now: ctx.now(),
      });
      await recordAudit(client, {
        clinicId: auth.clinicId,
        actorUserId: auth.userId,
        action: 'messages.simulated_inbound',
        entityType: 'clinic',
        entityId: auth.clinicId,
      });
    });
    return reply.code(202).send({ ok: true });
  });
}
