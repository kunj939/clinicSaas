import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, tdClass } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useClinicToday } from './useClinicToday';
import { useResource } from '../../lib/useResource';
import type { PatientSummary } from './PatientsPage';

export interface FollowUp {
  id: string;
  patientId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  dueDate: string;
  reason: string | null;
  status: string;
  lastReminderAt: string | null;
}

interface Doctor {
  id: string;
  name: string;
  isActive: boolean;
}

export function FollowUpsPage() {
  const { t, lang, errorText } = useI18n();
  const { user } = useAuth();
  const today = useClinicToday();
  const followUps = useResource(() => api.get<FollowUp[]>('/api/follow-ups?status=open'), []);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [showForm, setShowForm] = useState(false);

  async function remind(item: FollowUp) {
    setNotice(null);
    try {
      const result = await api.post<{ outcome: string }>(`/api/follow-ups/${item.id}/remind`);
      const key = `followups.outcome.${result.outcome}` as MessageKey;
      setNotice({ tone: result.outcome === 'queued' ? 'success' : 'info', text: t(key) });
      followUps.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  }

  async function markDone(item: FollowUp) {
    try {
      await api.post(`/api/follow-ups/${item.id}/done`);
      followUps.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('followups.title')}
        subtitle={t('followups.hint')}
        actions={<Button onClick={() => setShowForm((value) => !value)}>{t('followups.add')}</Button>}
      />
      {notice ? <Alert tone={notice.tone} onDismiss={() => setNotice(null)} dismissLabel={t('common.dismiss')}>{notice.text}</Alert> : null}

      {showForm ? (
        <NewFollowUp
          today={today}
          lockedDoctorId={user?.role === 'doctor' ? user.doctorId : null}
          onCreated={() => {
            setShowForm(false);
            setNotice({ tone: 'success', text: t('followups.created') });
            followUps.reload();
          }}
          onError={(text) => setNotice({ tone: 'error', text })}
        />
      ) : null}

      <Card>
        {followUps.loading && !followUps.data ? <Spinner label={t('app.loading')} /> : null}
        {followUps.error ? <Alert tone="error">{errorText(followUps.error)}</Alert> : null}
        {followUps.data && followUps.data.length === 0 ? <EmptyState>{t('followups.empty')}</EmptyState> : null}
        {followUps.data && followUps.data.length > 0 ? (
          <Table head={[t('followups.dueDate'), t('followups.patient'), t('followups.doctor'), t('common.reason'), t('common.actions')]}>
            {followUps.data.map((item) => {
              const overdue = item.dueDate < today;
              return (
                <tr key={item.id}>
                  <td className={`${tdClass} whitespace-nowrap`}>
                    <span className={overdue ? 'font-semibold text-red-700' : undefined}>{formatDate(item.dueDate, lang)}</span>
                    {overdue ? <span className="block text-xs text-red-700">{t('followups.overdue')}</span> : null}
                  </td>
                  <td className={tdClass}>
                    <p className="font-medium text-slate-900">{item.patientName}</p>
                    {item.lastReminderAt ? (
                      <p className="text-xs text-slate-500">{t('followups.lastReminder', { date: formatDate(item.lastReminderAt.slice(0, 10), lang) })}</p>
                    ) : null}
                  </td>
                  <td className={tdClass}>{item.doctorName}</td>
                  <td className={tdClass}>{item.reason ?? '—'}</td>
                  <td className={tdClass}>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => remind(item)}>
                        {t('followups.remind')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => markDone(item)}>
                        {t('followups.markDone')}
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}

function NewFollowUp({
  today,
  lockedDoctorId,
  onCreated,
  onError,
}: {
  today: string;
  lockedDoctorId: string | null;
  onCreated: () => void;
  onError: (text: string) => void;
}) {
  const { t, errorText } = useI18n();
  const doctors = useResource(() => api.get<Doctor[]>('/api/doctors'), []);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PatientSummary[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [doctorId, setDoctorId] = useState(lockedDoctorId ?? '');
  const [dueDate, setDueDate] = useState(today);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (search.trim().length < 2 || patient) {
      setHits([]);
      return;
    }
    const id = window.setTimeout(() => {
      api
        .get<PatientSummary[]>(`/api/patients?q=${encodeURIComponent(search.trim())}&limit=8`)
        .then(setHits)
        .catch(() => setHits([]));
    }, 300);
    return () => window.clearTimeout(id);
  }, [search, patient]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!patient || !doctorId) return;
    setBusy(true);
    try {
      await api.post('/api/follow-ups', { patientId: patient.id, doctorId, dueDate, reason: reason || null });
      onCreated();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('followups.add')}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <div className="space-y-2 sm:col-span-2">
          {patient ? (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-teal-50 p-3 ring-1 ring-teal-200">
              <span className="font-medium text-slate-900">{patient.fullName}</span>
              <Button size="sm" variant="secondary" onClick={() => setPatient(null)}>
                {t('queue.clearPatient')}
              </Button>
            </div>
          ) : (
            <Field id="fuSearch" label={t('followups.findPatient')}>
              <Input id="fuSearch" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
            </Field>
          )}
          {hits.length > 0 ? (
            <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button type="button" onClick={() => setPatient(hit)} className="flex w-full min-h-11 items-center justify-between px-3 py-2 text-start hover:bg-slate-50">
                    <span>{hit.fullName}</span>
                    <span className="text-xs text-slate-500">{hit.phoneMasked ?? '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <Field id="fuDoctor" label={t('followups.doctor')}>
          <Select id="fuDoctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} disabled={Boolean(lockedDoctorId)} required>
            <option value="">{t('common.select')}</option>
            {doctors.data?.filter((doctor) => doctor.isActive).map((doctor) => (
              <option key={doctor.id} value={doctor.id}>
                {doctor.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="fuDate" label={t('followups.dueDate')}>
          <Input id="fuDate" type="date" value={dueDate} min={today} onChange={(e) => setDueDate(e.target.value)} required />
        </Field>
        <Field id="fuReason" label={`${t('common.reason')} (${t('common.optional')})`}>
          <Input id="fuReason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={busy || !patient || !doctorId}>
            {busy ? t('common.saving') : t('common.add')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
