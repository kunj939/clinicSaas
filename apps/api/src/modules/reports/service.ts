import { createHash } from 'node:crypto';
import type { AppContext } from '../../context.js';
import type { AuthContext } from '../../auth/session.js';
import { assertDoctorScope } from '../../auth/guards.js';
import { withTransaction, type Db } from '../../db/pool.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { dateInTimeZone, periodOf } from '../../lib/clinic-time.js';
import { AppError, errors } from '../../lib/errors.js';
import { recordAudit } from '../audit/service.js';
import { getClinicById } from '../clinic/service.js';
import { enqueueMessage, type EnqueueResult } from '../messaging/outbox.js';
import { render } from '../messaging/templates.js';
import { ensureVisit } from '../visits/service.js';
import type { Lang } from '../messaging/templates.js';

type Scoped = AuthContext & { clinicId: string };

export type ReportMime = 'application/pdf' | 'image/jpeg' | 'image/png';

/** Identifies the real file type from its first bytes. The browser-declared type is not trusted. */
export function detectReportMime(buffer: Buffer): ReportMime | null {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

export interface ReportDto {
  id: string;
  title: string;
  status: 'draft' | 'ready';
  mimeType: ReportMime;
  sizeBytes: number;
  patientId: string;
  doctorId: string;
  visitId: string;
  readyAt: string | null;
  createdAt: string;
}

function toReportDto(row: Record<string, unknown>): ReportDto {
  return {
    id: row.id as string,
    title: row.title as string,
    status: row.status as 'draft' | 'ready',
    mimeType: row.mime_type as ReportMime,
    sizeBytes: row.size_bytes as number,
    patientId: row.patient_id as string,
    doctorId: row.doctor_id as string,
    visitId: row.visit_id as string,
    readyAt: row.ready_at ? (row.ready_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function uploadReport(
  ctx: AppContext,
  auth: Scoped,
  tokenId: string,
  input: { title: string; content: Buffer },
): Promise<ReportDto> {
  const mime = detectReportMime(input.content);
  if (!mime) throw new AppError(400, 'unsupported_file', 'Upload a PDF, JPEG or PNG file');
  if (input.content.length > ctx.config.maxReportBytes) throw new AppError(413, 'file_too_large', 'File is too large');
  const sha256 = createHash('sha256').update(input.content).digest('hex');

  return withTransaction(ctx.pool, async (client) => {
    const visit = await ensureVisit(client, auth, tokenId);
    const { rows } = await client.query(
      `INSERT INTO reports (clinic_id, visit_id, patient_id, doctor_id, title, mime_type, size_bytes, sha256, content, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        auth.clinicId,
        visit.id,
        visit.patientId,
        visit.doctorId,
        input.title,
        mime,
        input.content.length,
        sha256,
        input.content,
        auth.userId,
      ],
    );
    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'report.uploaded',
      entityType: 'report',
      entityId: rows[0].id,
      metadata: { mime, sizeBytes: input.content.length },
    });
    return toReportDto(rows[0]);
  });
}

export async function listReports(db: Db, clinicId: string, patientId: string | undefined) {
  const { rows } = await db.query(
    `SELECT id, title, status, mime_type, size_bytes, patient_id, doctor_id, visit_id, ready_at, created_at
       FROM reports
      WHERE clinic_id = $1 AND ($2::uuid IS NULL OR patient_id = $2)
      ORDER BY created_at DESC
      LIMIT 100`,
    [clinicId, patientId ?? null],
  );
  return rows.map(toReportDto);
}

export interface PublishResult {
  status: 'ready';
  notification: EnqueueResult | 'no_phone' | 'disabled';
  expiresAt: string;
}

/**
 * Marks the report ready and issues a fresh secure link. Earlier links for the report are revoked,
 * so only the most recent link works. Each publish sends at most one notification.
 */
export async function publishReport(
  ctx: AppContext,
  auth: Scoped,
  reportId: string,
  options: { notifyPatient: boolean },
): Promise<PublishResult> {
  const clinic = await getClinicById(ctx.pool, auth.clinicId);
  if (!clinic) throw errors.notFound('Clinic');

  return withTransaction(ctx.pool, async (client) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      doctor_id: string;
      patient_id: string;
    }>('SELECT id, title, doctor_id, patient_id FROM reports WHERE id = $1 AND clinic_id = $2 FOR UPDATE', [
      reportId,
      auth.clinicId,
    ]);
    const report = rows[0];
    if (!report) throw errors.notFound('Report');
    assertDoctorScope(auth, report.doctor_id);

    await client.query(
      `UPDATE reports SET status = 'ready', ready_at = COALESCE(ready_at, now()) WHERE id = $1`,
      [reportId],
    );
    await client.query(
      `UPDATE report_access_links SET revoked_at = now() WHERE report_id = $1 AND revoked_at IS NULL`,
      [reportId],
    );

    const secret = randomToken(32);
    const link = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO report_access_links (clinic_id, report_id, token_hash, expires_at, max_uses, created_by_user_id)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)
       RETURNING id, expires_at`,
      [auth.clinicId, reportId, sha256Hex(secret), ctx.config.reportLinkTtlHours, ctx.config.reportLinkMaxUses, auth.userId],
    );

    let notification: PublishResult['notification'] = 'disabled';
    if (options.notifyPatient) {
      const { rows: patientRows } = await client.query<{ phone_encrypted: string | null; preferred_language: Lang }>(
        'SELECT phone_encrypted, preferred_language FROM patients WHERE id = $1',
        [report.patient_id],
      );
      const patient = patientRows[0];
      if (!patient?.phone_encrypted) {
        notification = 'no_phone';
      } else {
        notification = await enqueueMessage(client, ctx.cipher, {
          clinicId: auth.clinicId,
          kind: 'notification',
          templateKey: 'report_ready',
          phone: ctx.cipher.decrypt(patient.phone_encrypted),
          text: render(patient.preferred_language, 'notif.report_ready', {
            clinic: clinic.name,
            title: report.title,
            hours: ctx.config.reportLinkTtlHours,
            link: `${ctx.config.publicApiUrl}/api/public/reports/${secret}`,
          }),
          dedupeKey: `report:${reportId}:link:${link.rows[0]!.id}`,
          period: periodOf(dateInTimeZone(ctx.now(), clinic.timezone)),
          quota: clinic.monthly_message_quota,
        });
      }
    }

    await recordAudit(client, {
      clinicId: auth.clinicId,
      actorUserId: auth.userId,
      action: 'report.published',
      entityType: 'report',
      entityId: reportId,
      metadata: { notification },
    });
    return { status: 'ready', notification, expiresAt: link.rows[0]!.expires_at.toISOString() };
  });
}

export async function getReportFile(db: Db, auth: Scoped, reportId: string) {
  const { rows } = await db.query<{ title: string; mime_type: ReportMime; content: Buffer; sha256: string }>(
    'SELECT title, mime_type, content, sha256 FROM reports WHERE id = $1 AND clinic_id = $2',
    [reportId, auth.clinicId],
  );
  if (!rows[0]) throw errors.notFound('Report');
  return rows[0];
}

/**
 * Serves a report to a patient holding a valid link. The use counter is incremented atomically
 * in the same statement that validates the link, so concurrent requests cannot exceed the limit.
 */
export async function fetchReportByLink(ctx: AppContext, secret: string) {
  const invalid = () => new AppError(404, 'link_invalid', 'This link is invalid or has expired');
  return withTransaction(ctx.pool, async (client) => {
    const consumed = await client.query<{ report_id: string; clinic_id: string }>(
      `UPDATE report_access_links
          SET use_count = use_count + 1
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND use_count < max_uses
        RETURNING report_id, clinic_id`,
      [sha256Hex(secret)],
    );
    const link = consumed.rows[0];
    if (!link) throw invalid();

    const { rows } = await client.query<{ title: string; mime_type: ReportMime; content: Buffer }>(
      `SELECT title, mime_type, content FROM reports WHERE id = $1 AND status = 'ready'`,
      [link.report_id],
    );
    if (!rows[0]) throw invalid();

    await recordAudit(client, {
      clinicId: link.clinic_id,
      actorUserId: null,
      action: 'report.link_used',
      entityType: 'report',
      entityId: link.report_id,
    });
    return rows[0];
  });
}

