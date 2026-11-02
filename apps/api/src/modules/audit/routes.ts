import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { listAuditLogs } from './service.js';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/audit-logs', async (request) => {
    const auth = await requireCapability('audit.view')(request);
    const params = query.parse(request.query);
    return listAuditLogs(app.ctx.pool, auth.clinicId, { limit: params.limit, beforeId: params.before });
  });
}
