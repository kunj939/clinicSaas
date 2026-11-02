import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../../auth/guards.js';
import { AppError, errors } from '../../lib/errors.js';
import { uuidParam } from '../../lib/schemas.js';
import { recordAudit } from '../audit/service.js';
import { fetchReportByLink, getReportFile, listReports, publishReport, uploadReport } from './service.js';

const listQuery = z.object({ patientId: z.uuid().optional() });
const publishBody = z.object({ notifyPatient: z.boolean().default(true) });
const linkParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{30,80}$/) });

function sendFile(
  reply: import('fastify').FastifyReply,
  file: { title: string; mime_type: string; content: Buffer },
  disposition: 'inline' | 'attachment',
) {
  const safeName = file.title.replace(/[^\w\s.-]/g, '').trim().slice(0, 80) || 'report';
  const extension = file.mime_type === 'application/pdf' ? 'pdf' : file.mime_type === 'image/png' ? 'png' : 'jpg';
  return reply
    .header('Content-Type', file.mime_type)
    .header('Content-Length', file.content.length)
    .header('Content-Disposition', `${disposition}; filename="${safeName}.${extension}"`)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Referrer-Policy', 'no-referrer')
    .header('Content-Security-Policy', "default-src 'none'; sandbox")
    .send(file.content);
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  const { ctx } = app;

  /** Multipart upload: fields `title` and `file`. Doctors upload for their own tokens. */
  app.post('/api/tokens/:id/reports', async (request, reply) => {
    const auth = await requireCapability('reports.upload')(request);
    const { id } = uuidParam.parse(request.params);

    let title = '';
    let content: Buffer | null = null;
    try {
      for await (const part of request.parts({ limits: { fileSize: ctx.config.maxReportBytes, files: 1, fields: 5 } })) {
        if (part.type === 'file' && part.fieldname === 'file') {
          content = await part.toBuffer();
        } else if (part.type === 'field' && part.fieldname === 'title') {
          title = String(part.value).trim();
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError(413, 'file_too_large', 'File is too large');
      }
      throw error;
    }

    if (!content || content.length === 0) throw errors.validation('Attach a file');
    const parsedTitle = z.string().min(1).max(160).parse(title || 'Report');
    const report = await uploadReport(ctx, auth, id, { title: parsedTitle, content });
    return reply.code(201).send(report);
  });

  app.get('/api/reports', async (request) => {
    const auth = await requireCapability('reports.view')(request);
    const query = listQuery.parse(request.query);
    return listReports(ctx.pool, auth.clinicId, query.patientId);
  });

  /** Staff download (for preview in the app). Never cached by shared caches. */
  app.get('/api/reports/:id/file', async (request, reply) => {
    const auth = await requireCapability('reports.view')(request);
    const { id } = uuidParam.parse(request.params);
    const file = await getReportFile(ctx.pool, auth, id);
    await recordAudit(ctx.pool, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'report.viewed',
      entityType: 'report',
      entityId: id,
    });
    return sendFile(reply, file, 'inline');
  });

  app.post('/api/reports/:id/publish', async (request) => {
    const auth = await requireCapability('reports.upload')(request);
    const { id } = uuidParam.parse(request.params);
    const body = publishBody.parse(request.body ?? {});
    return publishReport(ctx, auth, id, { notifyPatient: body.notifyPatient });
  });

  /** Public, bearer-link access for patients. Rate limited and never indexed. */
  app.get(
    '/api/public/reports/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = linkParam.safeParse(request.params);
      if (!parsed.success) throw new AppError(404, 'link_invalid', 'This link is invalid or has expired');
      const file = await fetchReportByLink(ctx, parsed.data.token);
      return sendFile(reply.header('X-Robots-Tag', 'noindex, nofollow'), file, 'attachment');
    },
  );
}
