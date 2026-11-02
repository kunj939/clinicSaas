import { useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Spinner, Table, Textarea, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import { api, reportFileUrl } from '../../lib/api';
import { addDaysIso, formatDate } from '../../lib/format';
import { usePolling, useResource } from '../../lib/useResource';
import type { QueueItem, QueueResponse } from '../reception/QueuePage';
import { statusTone } from '../shared/status';
import { useClinicToday } from '../shared/useClinicToday';

interface Visit {
  id: string;
  diagnosis: string | null;
  clinicalNotes: string | null;
  prescription: string | null;
  medicineDays: number | null;
  followUpDate: string | null;
}

interface ReportRow {
  id: string;
  title: string;
  status: 'draft' | 'ready';
  mimeType: string;
  createdAt: string;
  readyAt: string | null;
}

interface FollowUpRow {
  id: string;
  patientName: string;
  dueDate: string;
  reason: string | null;
}

type Notice = { tone: 'error' | 'success' | 'info'; text: string };

interface DoctorOption {
  id: string;
  isActive: boolean;
}

export function DoctorQueuePage() {
  const { t, errorText, lang } = useI18n();
  const { user } = useAuth();
  // A doctor works their own queue. A single-doctor clinic's owner works the clinic's only active doctor.
  const doctors = useResource(() => (user?.role === 'owner' ? api.get<DoctorOption[]>('/api/doctors') : Promise.resolve(null)), [user?.role]);
  const doctorId = user?.doctorId ?? doctors.data?.find((doctor) => doctor.isActive)?.id ?? '';
  const today = useClinicToday();

  const queue = useResource(
    () => (doctorId ? api.get<QueueResponse>(`/api/queue?doctorId=${doctorId}&date=${today}`) : Promise.resolve(null)),
    [doctorId, today],
  );
  usePolling(() => queue.reload(), 15_000);
  const followUps = useResource(() => api.get<FollowUpRow[]>('/api/follow-ups?status=open'), []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const tokens = queue.data?.tokens ?? [];
  const serving = tokens.find((item) => item.status === 'in_consultation') ?? null;
  const waiting = tokens.filter((item) => item.status === 'checked_in');
  const selected = tokens.find((item) => item.id === selectedId) ?? serving ?? null;

  async function callNext() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.post<{ token: QueueItem | null }>('/api/queue/call-next', { doctorId, date: today });
      if (result.token) setSelectedId(result.token.id);
      else setNotice({ tone: 'info', text: t('doctor.noOneWaiting') });
      queue.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function complete(item: QueueItem) {
    setBusy(true);
    try {
      await api.post(`/api/tokens/${item.id}/complete`);
      setNotice({ tone: 'success', text: t('doctor.complete') });
      queue.reload();
      followUps.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('doctor.title')}
        subtitle={queue.data ? `${queue.data.doctor.name} · ${formatDate(today, lang)}` : undefined}
        actions={
          <Button onClick={callNext} disabled={busy || Boolean(serving)}>
            {t('doctor.callNext')}
          </Button>
        }
      />
      {notice ? <Alert tone={notice.tone} onDismiss={() => setNotice(null)} dismissLabel={t('common.dismiss')}>{notice.text}</Alert> : null}
      {queue.loading && !queue.data ? <Spinner label={t('app.loading')} /> : null}
      {queue.error ? <Alert tone="error">{errorText(queue.error)}</Alert> : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6">
          <Card title={t('doctor.nowServing')}>
            {serving ? (
              <div className="space-y-3">
                <p className="text-2xl font-semibold text-slate-900">
                  #{serving.tokenNumber} · {serving.patientName}
                </p>
                <Button variant="secondary" onClick={() => complete(serving)} disabled={busy}>
                  {t('doctor.complete')}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-600">{t('doctor.noOneWaiting')}</p>
            )}
          </Card>

          <Card title={`${t('queue.waiting')} (${waiting.length})`}>
            {tokens.length === 0 && !queue.loading ? <EmptyState>{t('queue.empty')}</EmptyState> : null}
            <ul className="divide-y divide-slate-100">
              {tokens
                .filter((item) => item.status !== 'cancelled' && item.status !== 'no_show')
                .map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      className={`flex w-full min-h-11 items-center justify-between gap-3 px-2 py-2 text-start hover:bg-slate-50 ${selected?.id === item.id ? 'bg-teal-50' : ''}`}
                    >
                      <span className="min-w-0">
                        <span className="font-semibold text-slate-900">#{item.tokenNumber}</span>{' '}
                        <span className="truncate text-slate-800">{item.patientName}</span>
                      </span>
                      <Badge tone={statusTone(item.status)}>{t(`status.${item.status}` as MessageKey)}</Badge>
                    </button>
                  </li>
                ))}
            </ul>
          </Card>

          <Card title={t('doctor.followUpsDue')}>
            {followUps.data && followUps.data.length === 0 ? <p className="text-sm text-slate-600">{t('doctor.noFollowUps')}</p> : null}
            <ul className="space-y-2 text-sm">
              {followUps.data?.slice(0, 8).map((item) => (
                <li key={item.id} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate text-slate-800">{item.patientName}</span>
                  <span className="shrink-0 text-slate-600">{formatDate(item.dueDate, lang)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-6 xl:col-span-2">
          {selected ? (
            <>
              <VisitPanel key={selected.id} token={selected} onSaved={() => queue.reload()} />
              <ReportsPanel key={`reports-${selected.id}`} token={selected} />
            </>
          ) : (
            <Card>
              <EmptyState>{t('doctor.selectPatient')}</EmptyState>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/** Quick choices for how long a medicine course lasts. */
const MEDICINE_CHOICES = [7, 15, 30, 60, 90];

function VisitPanel({ token, onSaved }: { token: QueueItem; onSaved: () => void }) {
  const { t, errorText, lang } = useI18n();
  const { clinic } = useAuth();
  const today = useClinicToday();
  const visit = useResource(() => api.get<Visit | null>(`/api/tokens/${token.id}/visit`), [token.id]);
  const seen = token.status === 'in_consultation' || token.status === 'completed';
  const [diagnosis, setDiagnosis] = useState<string | null>(null);
  const [clinicalNotes, setClinicalNotes] = useState<string | null>(null);
  const [prescription, setPrescription] = useState<string | null>(null);
  const [medicineDays, setMedicineDays] = useState<string | null>(null);
  const [followUpDate, setFollowUpDate] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const current = visit.data;
  const values = {
    diagnosis: diagnosis ?? current?.diagnosis ?? '',
    clinicalNotes: clinicalNotes ?? current?.clinicalNotes ?? '',
    prescription: prescription ?? current?.prescription ?? '',
    medicineDays: medicineDays ?? (current?.medicineDays ? String(current.medicineDays) : ''),
    // A date from an earlier medicine course is computed, not typed, so it is not shown as a manual date.
    followUpDate: followUpDate ?? (current?.medicineDays ? '' : (current?.followUpDate ?? '')),
  };
  const days = Number(values.medicineDays);
  const leadDays = clinic?.followUpLeadDays ?? 1;
  const reminderDate = days >= 1 ? addDaysIso(today, Math.max(1, days - leadDays)) : null;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api.put(`/api/tokens/${token.id}/visit`, {
        diagnosis: values.diagnosis || null,
        clinicalNotes: values.clinicalNotes || null,
        prescription: values.prescription || null,
        medicineDays: days >= 1 ? days : null,
        followUpDate: values.followUpDate || null,
      });
      setNotice({ tone: 'success', text: t('doctor.visitSaved') });
      visit.reload();
      onSaved();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`${t('doctor.visitTitle')} · #${token.tokenNumber} ${token.patientName}`}>
      {!seen ? <Alert tone="info">{t('doctor.visitNeedsSeen')}</Alert> : null}
      {notice ? <div className="mb-4"><Alert tone={notice.tone}>{notice.text}</Alert></div> : null}
      <form onSubmit={save} className="space-y-4" noValidate>
        <Field id="diagnosis" label={t('doctor.diagnosis')}>
          <Input id="diagnosis" value={values.diagnosis} disabled={!seen} onChange={(e) => setDiagnosis(e.target.value)} maxLength={2000} />
        </Field>
        <Field id="clinicalNotes" label={t('doctor.clinicalNotes')}>
          <Textarea id="clinicalNotes" value={values.clinicalNotes} disabled={!seen} onChange={(e) => setClinicalNotes(e.target.value)} maxLength={10000} />
        </Field>
        <Field id="prescription" label={t('doctor.prescription')}>
          <Textarea id="prescription" value={values.prescription} disabled={!seen} onChange={(e) => setPrescription(e.target.value)} maxLength={5000} />
        </Field>
        <Field id="medicineDays" label={`${t('doctor.medicineDays')} (${t('common.optional')})`} hint={t('doctor.medicineHint')}>
          <div className="flex flex-wrap items-center gap-2">
            {MEDICINE_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={!seen}
                onClick={() => setMedicineDays(String(choice))}
                className={`min-h-10 rounded-full px-3 text-sm font-medium ring-1 ring-inset disabled:opacity-50 ${
                  days === choice ? 'bg-teal-700 text-white ring-teal-700' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50'
                }`}
              >
                {t('doctor.daysChip', { n: choice })}
              </button>
            ))}
            <Input
              id="medicineDays"
              type="number"
              inputMode="numeric"
              min={1}
              max={366}
              className="w-24!"
              value={values.medicineDays}
              disabled={!seen}
              onChange={(e) => setMedicineDays(e.target.value)}
            />
          </div>
          {reminderDate ? <p className="mt-2 text-sm font-medium text-teal-800">{t('doctor.reminderOn', { date: formatDate(reminderDate, lang) })}</p> : null}
        </Field>
        <Field id="followUp" label={`${t('doctor.followUpDate')} (${t('common.optional')})`} hint={t('doctor.followUpHint')}>
          <Input id="followUp" type="date" value={values.followUpDate} disabled={!seen} onChange={(e) => setFollowUpDate(e.target.value)} />
        </Field>
        <Button type="submit" disabled={!seen || busy}>
          {busy ? t('common.saving') : t('doctor.saveVisit')}
        </Button>
      </form>
    </Card>
  );
}

function ReportsPanel({ token }: { token: QueueItem }) {
  const { t, errorText, lang } = useI18n();
  const reports = useResource(() => api.get<ReportRow[]>(`/api/reports?patientId=${token.patientId}`), [token.patientId]);
  const seen = token.status === 'in_consultation' || token.status === 'completed';
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [notify, setNotify] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      const form = new FormData();
      form.append('title', title || file.name);
      form.append('file', file);
      await api.upload(`/api/tokens/${token.id}/reports`, form);
      setTitle('');
      setFile(null);
      setNotice({ tone: 'success', text: t('doctor.uploaded') });
      reports.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function publish(report: ReportRow) {
    setNotice(null);
    try {
      const result = await api.post<{ notification: string }>(`/api/reports/${report.id}/publish`, { notifyPatient: notify });
      const text = {
        queued: t('doctor.published'),
        no_phone: t('doctor.publishedNoPhone'),
        quota_exceeded: t('doctor.publishedQuota'),
        disabled: t('doctor.publishedNoNotify'),
        duplicate: t('doctor.published'),
      }[result.notification] ?? t('doctor.published');
      setNotice({ tone: 'success', text });
      reports.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  }

  return (
    <Card title={t('doctor.reportsTitle')}>
      {notice ? <div className="mb-4"><Alert tone={notice.tone} onDismiss={() => setNotice(null)} dismissLabel={t('common.dismiss')}>{notice.text}</Alert></div> : null}

      {reports.loading && !reports.data ? <Spinner label={t('app.loading')} /> : null}
      {reports.data && reports.data.length === 0 ? <p className="mb-4 text-sm text-slate-600">{t('doctor.noReports')}</p> : null}
      {reports.data && reports.data.length > 0 ? (
        <div className="mb-6">
          <Table head={[t('common.name'), t('common.status'), t('common.created'), t('common.actions')]}>
            {reports.data.map((report) => (
              <tr key={report.id}>
                <td className={`${tdClass} font-medium`}>{report.title}</td>
                <td className={tdClass}>
                  <Badge tone={report.status === 'ready' ? 'green' : 'slate'}>
                    {report.status === 'ready' ? t('doctor.readyBadge') : t('doctor.draft')}
                  </Badge>
                </td>
                <td className={`${tdClass} whitespace-nowrap`}>{formatDate(report.createdAt.slice(0, 10), lang)}</td>
                <td className={tdClass}>
                  <div className="flex flex-wrap gap-2">
                    <a href={reportFileUrl(report.id)} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center px-2 font-medium text-teal-800 underline">
                      {t('doctor.view')}
                    </a>
                    {report.status === 'draft' || report.status === 'ready' ? (
                      <Button size="sm" variant="secondary" onClick={() => publish(report)}>
                        {t('doctor.publish')}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
          <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" className="size-5 accent-teal-700" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            {t('doctor.publishNotify')}
          </label>
        </div>
      ) : null}

      <form onSubmit={upload} className="space-y-4 border-t border-slate-200 pt-5" noValidate>
        <h3 className="font-medium text-slate-900">{t('doctor.uploadTitle')}</h3>
        {!seen ? <p className="text-sm text-slate-600">{t('doctor.visitNeedsSeen')}</p> : null}
        <Field id="reportTitle" label={t('doctor.reportTitle')}>
          <Input id="reportTitle" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} disabled={!seen} />
        </Field>
        <Field id="reportFile" label={t('common.required')} hint={t('doctor.reportFile')}>
          <input
            id="reportFile"
            type="file"
            accept="application/pdf,image/jpeg,image/png"
            disabled={!seen}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full min-h-11 text-sm file:me-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-teal-50 file:px-4 file:font-medium file:text-teal-900 disabled:opacity-50"
          />
        </Field>
        <Button type="submit" variant="secondary" disabled={!seen || !file || busy}>
          {busy ? t('common.saving') : t('doctor.upload')}
        </Button>
      </form>
    </Card>
  );
}
