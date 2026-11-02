import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../../db/pool.js';
import { safeEqualStrings } from '../../lib/crypto.js';
import { normalizePhone } from '../../lib/phone.js';
import { handleInbound } from './bot.js';

const payloadSchema = z.looseObject({
  entry: z
    .array(
      z.looseObject({
        changes: z
          .array(
            z.looseObject({
              value: z
                .looseObject({
                  metadata: z.looseObject({ phone_number_id: z.string() }).optional(),
                  messages: z
                    .array(
                      z.looseObject({
                        id: z.string().min(1).max(200),
                        from: z.string().regex(/^\d{6,20}$/),
                        type: z.string(),
                        text: z.looseObject({ body: z.string().max(4000) }).optional(),
                      }),
                    )
                    .optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/** Meta signs the raw request body with the app secret: X-Hub-Signature-256 = sha256=<hex>. */
export function verifyMetaSignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  const received = Buffer.from(header.slice('sha256='.length), 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function registerWhatsappRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  /** Meta's one-time subscription handshake. */
  app.get('/api/webhooks/whatsapp', async (request, reply) => {
    const query = z
      .object({
        'hub.mode': z.string().optional(),
        'hub.verify_token': z.string().optional(),
        'hub.challenge': z.string().max(200).optional(),
      })
      .parse(request.query);
    const expected = ctx.config.whatsapp.verifyToken;
    if (
      expected &&
      query['hub.mode'] === 'subscribe' &&
      query['hub.verify_token'] !== undefined &&
      safeEqualStrings(query['hub.verify_token'], expected) &&
      query['hub.challenge']
    ) {
      return reply.type('text/plain').send(query['hub.challenge']);
    }
    return reply.code(403).send({ error: 'forbidden' });
  });

  app.post('/api/webhooks/whatsapp', async (request, reply) => {
    const secret = ctx.config.whatsapp.appSecret;
    // Without a secret, only non-production environments accept unsigned payloads (local testing).
    if (!secret && ctx.config.isProduction) return reply.code(403).send({ error: 'webhook_disabled' });
    if (secret) {
      const signature = request.headers['x-hub-signature-256'];
      if (!verifyMetaSignature(request.rawBody ?? '', typeof signature === 'string' ? signature : undefined, secret)) {
        return reply.code(401).send({ error: 'bad_signature' });
      }
    }

    const parsed = payloadSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'bad_payload' });

    let processed = 0;
    let duplicates = 0;
    let unrouted = 0;

    for (const entry of parsed.data.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        for (const message of change.value?.messages ?? []) {
          const outcome = await withTransaction(ctx.pool, async (client) => {
            // The first insert wins; a provider retry of the same message finds the row and stops here.
            const inserted = await client.query(
              `INSERT INTO whatsapp_webhook_events (provider, external_id) VALUES ('meta', $1)
               ON CONFLICT (provider, external_id) DO NOTHING`,
              [message.id],
            );
            if (!inserted.rowCount) return 'duplicate';

            const clinic = phoneNumberId
              ? await client.query<{ id: string }>('SELECT id FROM clinics WHERE whatsapp_phone_number_id = $1', [
                  phoneNumberId,
                ])
              : null;
            const clinicId = clinic?.rows[0]?.id;
            const phone = normalizePhone(`+${message.from}`, ctx.config.defaultCountryCode);
            if (!clinicId || !phone) return 'unrouted';

            await handleInbound(ctx, client, {
              clinicId,
              phone,
              text: message.type === 'text' ? (message.text?.body ?? null) : null,
              now: ctx.now(),
            });
            return 'processed';
          });
          if (outcome === 'processed') processed += 1;
          else if (outcome === 'duplicate') duplicates += 1;
          else unrouted += 1;
        }
      }
    }
    return { received: true, processed, duplicates, unrouted };
  });
}
