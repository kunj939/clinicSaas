import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, createPatient, describeDb, json, request, seedClinic, TOMORROW, type Harness, type SeededClinic } from './harness.js';

function multipart(fields: Record<string, string>, file: { name: string; type: string; content: Buffer }) {
  const boundary = `----clinic${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');

describeDb('visits, follow-ups and secure reports', () => {
  let h: Harness;
  let clinic: SeededClinic;
  let tokenId: string;
  let patientId: string;
  let reportId: string;

  beforeAll(async () => {
    h = await createHarness({ RATE_LIMIT_AUTH_PER_MINUTE: '10000' });
    clinic = await seedClinic(h, { doctors: 2, capacity: 10 });
    patientId = await createPatient(h, clinic.reception, 'Meena Iyer', '+919811100050');
    const booked = await json(
      await request(h, 'POST', '/api/tokens', {
        cookie: clinic.reception,
        body: { doctorId: clinic.doctors[0]!.id, date: TOMORROW, source: 'phone', patient: { patientId }, notifyPatient: false },
      }),
    );
    tokenId = booked.token.id;
  });
  afterAll(async () => h.close());

  it('will not accept notes or reports before the patient has been seen', async () => {
    const notes = await request(h, 'PUT', `/api/tokens/${tokenId}/visit`, {
      cookie: clinic.doctors[0]!.cookie,
      body: { diagnosis: 'Viral fever' },
    });
    expect(notes.statusCode).toBe(409);

    const upload = multipart({ title: 'Blood test' }, { name: 'cbc.pdf', type: 'application/pdf', content: PDF });
    const early = await request(h, 'POST', `/api/tokens/${tokenId}/reports`, {
      cookie: clinic.doctors[0]!.cookie,
      rawPayload: upload.body,
      headers: { 'content-type': upload.contentType },
    });
    expect(early.statusCode).toBe(409);
  });

  it('lets the treating doctor save notes and creates a follow-up from a follow-up date', async () => {
    await request(h, 'POST', `/api/tokens/${tokenId}/check-in`, { cookie: clinic.reception });
    await request(h, 'POST', '/api/queue/call-next', {
      cookie: clinic.doctors[0]!.cookie,
      body: { doctorId: clinic.doctors[0]!.id, date: TOMORROW },
    });

    const saved = await request(h, 'PUT', `/api/tokens/${tokenId}/visit`, {
      cookie: clinic.doctors[0]!.cookie,
      body: { diagnosis: 'Viral fever', clinicalNotes: 'Afebrile on review', prescription: 'Paracetamol 500mg', followUpDate: '2026-11-05' },
    });
    expect(saved.statusCode).toBe(200);
    expect(await json(saved)).toMatchObject({ diagnosis: 'Viral fever', followUpDate: '2026-11-05' });

    const followUps = await json(await request(h, 'GET', '/api/follow-ups', { cookie: clinic.reception }));
    expect(followUps).toEqual([expect.objectContaining({ patientName: 'Meena Iyer', dueDate: '2026-11-05', status: 'open' })]);

    // Saving again without a follow-up date closes the automatic follow-up.
    await request(h, 'PUT', `/api/tokens/${tokenId}/visit`, {
      cookie: clinic.doctors[0]!.cookie,
      body: { diagnosis: 'Viral fever', followUpDate: null },
    });
    const open = await json(await request(h, 'GET', '/api/follow-ups?status=open', { cookie: clinic.reception }));
    expect(open).toEqual([]);
  });

  it('keeps notes private from another doctor in the same clinic', async () => {
    const other = await request(h, 'GET', `/api/tokens/${tokenId}/visit`, { cookie: clinic.doctors[1]!.cookie });
    expect(other.statusCode).toBe(403);
  });

  it('accepts only real PDF, JPEG or PNG content and only from the treating doctor', async () => {
    const disguised = multipart({ title: 'Scan' }, { name: 'scan.pdf', type: 'application/pdf', content: Buffer.from('MZ\x90\x00 not a pdf') });
    const rejected = await request(h, 'POST', `/api/tokens/${tokenId}/reports`, {
      cookie: clinic.doctors[0]!.cookie,
      rawPayload: disguised.body,
      headers: { 'content-type': disguised.contentType },
    });
    expect(rejected.statusCode).toBe(400);
    expect((await json(rejected)).error).toBe('unsupported_file');

    const wrongDoctor = multipart({ title: 'Scan' }, { name: 'scan.pdf', type: 'application/pdf', content: PDF });
    expect(
      (
        await request(h, 'POST', `/api/tokens/${tokenId}/reports`, {
          cookie: clinic.doctors[1]!.cookie,
          rawPayload: wrongDoctor.body,
          headers: { 'content-type': wrongDoctor.contentType },
        })
      ).statusCode,
    ).toBe(403);

    const asReception = multipart({ title: 'Scan' }, { name: 'scan.pdf', type: 'application/pdf', content: PDF });
    expect(
      (
        await request(h, 'POST', `/api/tokens/${tokenId}/reports`, {
          cookie: clinic.reception,
          rawPayload: asReception.body,
          headers: { 'content-type': asReception.contentType },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('stores an accepted report as a draft and reports the real MIME type', async () => {
    const upload = multipart({ title: 'Blood test' }, { name: 'cbc.pdf', type: 'image/png', content: PDF });
    const response = await request(h, 'POST', `/api/tokens/${tokenId}/reports`, {
      cookie: clinic.doctors[0]!.cookie,
      rawPayload: upload.body,
      headers: { 'content-type': upload.contentType },
    });
    expect(response.statusCode).toBe(201);
    const report = await json(response);
    reportId = report.id;
    expect(report).toMatchObject({ status: 'draft', mimeType: 'application/pdf', title: 'Blood test' });
  });

  it('publishes the report, sends one secure link, and serves the file only through that link', async () => {
    const published = await request(h, 'POST', `/api/reports/${reportId}/publish`, {
      cookie: clinic.doctors[0]!.cookie,
      body: { notifyPatient: true },
    });
    expect(published.statusCode).toBe(200);
    expect(await json(published)).toMatchObject({ status: 'ready', notification: 'queued' });

    const link = await latestReportLink(h);
    const anonymous = await h.app.inject({ method: 'GET', url: `/api/public/reports/${link}` });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.headers['content-type']).toBe('application/pdf');
    expect(anonymous.headers['content-disposition']).toMatch(/^attachment; filename="Blood test\.pdf"/);
    expect(anonymous.headers['cache-control']).toBe('private, no-store');
    expect(anonymous.headers['x-content-type-options']).toBe('nosniff');
    expect(anonymous.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(anonymous.rawPayload.equals(PDF)).toBe(true);
  });

  it('rejects malformed and unknown links with the same response', async () => {
    const malformed = await h.app.inject({ method: 'GET', url: '/api/public/reports/short' });
    const unknown = await h.app.inject({ method: 'GET', url: `/api/public/reports/${'A'.repeat(43)}` });
    expect(malformed.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(await json(malformed)).toEqual(await json(unknown));
  });

  it('enforces the link use limit atomically', async () => {
    const link = await latestReportLink(h);
    await h.pool.query(`UPDATE report_access_links SET max_uses = use_count + 1 WHERE report_id = $1 AND revoked_at IS NULL`, [reportId]);
    expect((await h.app.inject({ method: 'GET', url: `/api/public/reports/${link}` })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: `/api/public/reports/${link}` })).statusCode).toBe(404);
  });

  it('expires links and revokes older links when a report is published again', async () => {
    await h.pool.query(`UPDATE report_access_links SET expires_at = now() - interval '1 minute' WHERE report_id = $1`, [reportId]);
    const expired = await latestReportLink(h);
    expect((await h.app.inject({ method: 'GET', url: `/api/public/reports/${expired}` })).statusCode).toBe(404);

    const republished = await request(h, 'POST', `/api/reports/${reportId}/publish`, {
      cookie: clinic.doctors[0]!.cookie,
      body: { notifyPatient: true },
    });
    expect(republished.statusCode).toBe(200);
    const fresh = await latestReportLink(h);
    expect(fresh).not.toBe(expired);
    expect((await h.app.inject({ method: 'GET', url: `/api/public/reports/${fresh}` })).statusCode).toBe(200);

    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM report_access_links WHERE report_id = $1 AND revoked_at IS NULL`, [reportId]);
    expect(rows[0].n).toBe(1);
  });

  it('gives staff in the same clinic a private download and hides it from other clinics', async () => {
    const download = await h.app.inject({
      method: 'GET',
      url: `/api/reports/${reportId}/file`,
      headers: { cookie: clinic.reception },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['cache-control']).toBe('private, no-store');
    expect(download.rawPayload.equals(PDF)).toBe(true);

    const outsider = await seedClinic(h, { doctors: 1 });
    const blocked = await h.app.inject({ method: 'GET', url: `/api/reports/${reportId}/file`, headers: { cookie: outsider.reception } });
    expect(blocked.statusCode).toBe(404);
  });

  it('keeps the audit trail for report access without storing the link', async () => {
    const { rows } = await h.pool.query(
      `SELECT action, metadata::text AS metadata FROM audit_logs WHERE action LIKE 'report.%'`,
    );
    expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining(['report.uploaded', 'report.published', 'report.link_used', 'report.viewed']));
    expect(rows.some((row) => /\/api\/public|[A-Za-z0-9_-]{40,}/.test(row.metadata))).toBe(false);
  });

  it('turns a follow-up into a single reminder per due date via the API', async () => {
    const created = await json(
      await request(h, 'POST', '/api/follow-ups', {
        cookie: clinic.reception,
        body: { patientId, doctorId: clinic.doctors[0]!.id, dueDate: '2026-11-12', reason: 'Lab review' },
      }),
    );
    const done = await request(h, 'POST', `/api/follow-ups/${created.id}/done`, { cookie: clinic.doctors[0]!.cookie });
    expect(done.statusCode).toBe(200);
    const again = await request(h, 'POST', `/api/follow-ups/${created.id}/done`, { cookie: clinic.doctors[0]!.cookie });
    expect(again.statusCode).toBe(409);
  });
});

async function latestReportLink(h: Harness): Promise<string> {
  const { rows } = await h.pool.query(
    `SELECT body_encrypted FROM outbound_messages WHERE template_key = 'report_ready' ORDER BY created_at DESC, id DESC`,
  );
  const body = h.cipher.decrypt(rows[0]!.body_encrypted as string);
  const match = body.match(/\/api\/public\/reports\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`no link in message: ${body}`);
  return match[1]!;
}
