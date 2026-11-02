import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { isoDate } from '../../lib/schemas.js';
import { getDiary } from './service.js';

const diaryQuery = z.object({
  date: isoDate,
  doctorId: z.uuid().optional(),
});

export async function registerDiaryRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  app.get('/api/diary', async (request) => {
    const auth = await requireCapability('diary.view')(request);
    const query = diaryQuery.parse(request.query);
    return getDiary(ctx.pool, ctx.cipher, auth, query);
  });
}
