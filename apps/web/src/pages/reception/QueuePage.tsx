import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, ProgressBar, Select, Spinner, Stat, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { useResource, usePolling } from '../../lib/useResource';
import { useAuth } from '../../auth/AuthContext';
import { useClinicToday } from '../shared/useClinicToday';
import { statusTone } from '../shared/status';

export interface QueueItem {
  id: string;
  tokenNumber: number;
  status: 'booked' | 'checked_in' | 'in_consultation' | 'completed' | 'no_show' | 'cancelled';
  source: 'whatsapp' | 'phone' | 'walk_in';
  patientId: string;
  patientName: string;
  phoneMasked: string | null;
  visitId: string | null;
  checkedInAt: string | null;
  calledAt: string | null;
}

export interface QueueResponse {
  date: string;
  doctor: { id: string; name: string; isActive: boolean };
  capacity: number;
  activeCount: number;
  lastTokenNumber: number;
  tokens: QueueItem[];
}

interface Doctor {
  id: string;
  name: string;
  isActive: boolean;
}

interface PatientHit {
  id: string;
  fullName: string;
  phoneMasked: string | null;
}

const NOTIFY_KEYS = {
  queued: 'queue.notifyResult.queued',
  quota_exceeded: 'queue.notifyResult.quota_exceeded',
  no_phone: 'queue.notifyResult.no_phone',
  disabled: 'queue.notifyResult.disabled',
  duplicate: 'queue.notifyResult.duplicate',
  skipped: 'queue.notifyResult.skipped',
} as const satisfies Record<string, MessageKey>;

export function QueuePage() {
  const { t, errorText, lang } = useI18n();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const today = useClinicToday();
  const [date, setDate] = useState<string | null>(null);
  const activeDate = date ?? today;

  const doctors = useResource(() => api.get<Doctor[]>('/api/doctors'), []);
  const activeDoctors = doctors.data?.filter((doctor) => doctor.isActive) ?? [];
  const doctorId = params.get('doctor') ?? activeDoctors[0]?.id ?? '';

  const queue = useResource(
    () => (doctorId ? api.get<QueueResponse>(`/api/queue?doctorId=${doctorId}&date=${activeDate}`) : Promise.resolve(null)),
    [doctorId, activeDate],
  );
  usePolling(() => queue.reload(), 20_000);

  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function act(path: string, successText?: string) {
    setNotice(null);
    try {
      await api.post(path);
      if (successText) setNotice({ tone: 'success', text: successText });
      queue.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  }

  async function cancel(item: QueueItem) {
    if (!window.confirm(t('queue.confirmCancel'))) return;
    await act(`/api/tokens/${item.id}/cancel`);
  }

  if (doctors.loading && !doctors.data) return <Spinner label={t('app.loading')} />;

  const tokens = queue.data?.tokens ?? [];
  const waiting = tokens.filter((item) => item.status === 'checked_in').length;
  const withDoctor = tokens.filter((item) => item.status === 'in_consultation').length;
  const done = tokens.filter((item) => item.status === 'completed').length;
  const slotsLeft = queue.data ? Math.max(0, queue.data.capacity - queue.data.activeCount) : null;

  return (
    <div className="space-y-6">
      <PageHeader title={t('queue.title')} subtitle={t('queue.patientsHint')} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t('queue.kpiWaiting')} value={waiting} icon="clock" tone="amber" />
        <Stat label={t('queue.kpiWith')} value={withDoctor} icon="pulse" tone="teal" />
        <Stat label={t('queue.kpiDone')} value={done} icon="check" tone="green" />
        <Stat label={t('queue.kpiSlots')} value={slotsLeft ?? '—'} icon="users" tone="blue" />
      </div>

      <Card>
        {/* A single-doctor clinic has nothing to choose, so the doctor picker is shown only when there are several. */}
        <div className={`grid gap-4 ${activeDoctors.length > 1 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          {activeDoctors.length > 1 ? (
            <Field id="queueDoctor" label={t('queue.doctor')}>
              <Select
                id="queueDoctor"
                value={doctorId}
                onChange={(e) => setParams({ doctor: e.target.value })}
                disabled={activeDoctors.length === 0}
              >
                {activeDoctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {activeDoctors.length === 0 ? <p className="text-sm text-slate-600 sm:col-span-2">{t('owner.noDoctors')}</p> : null}
          <Field id="queueDate" label={t('queue.date')}>
            <Input id="queueDate" type="date" value={activeDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <p className="text-xs text-slate-500">{t('queue.autoRefresh')}</p>
          </div>
        </div>
        {queue.data ? (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium text-slate-800">
              {t('queue.capacity', { active: queue.data.activeCount, capacity: queue.data.capacity })}
            </p>
            <ProgressBar value={queue.data.activeCount} max={queue.data.capacity} label={t('queue.capacity', { active: queue.data.activeCount, capacity: queue.data.capacity })} />
          </div>
        ) : null}
      </Card>

      {notice ? (
        <Alert tone={notice.tone} onDismiss={() => setNotice(null)} dismissLabel={t('common.dismiss')}>
          {notice.text}
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title={t('queue.title')} className="xl:col-span-2">
          {!doctorId ? <EmptyState>{t('owner.noDoctors')}</EmptyState> : null}
          {queue.loading && !queue.data && doctorId ? <Spinner label={t('app.loading')} /> : null}
          {queue.error ? <Alert tone="error">{errorText(queue.error)}</Alert> : null}
          {queue.data && queue.data.tokens.length === 0 ? <EmptyState>{t('queue.empty')}</EmptyState> : null}
          {queue.data && queue.data.tokens.length > 0 ? (
            <Table head={[t('queue.tokenNumber'), t('queue.patient'), t('common.status'), t('queue.source.short'), t('common.actions')]}>
              {queue.data.tokens.map((item) => (
                <tr key={item.id} className={item.status === 'in_consultation' ? 'bg-teal-50/60' : undefined}>
                  <td className={`${tdClass} text-lg font-semibold`}>{item.tokenNumber}</td>
                  <td className={tdClass}>
                    <p className="font-medium text-slate-900">{item.patientName}</p>
                    <p className="text-xs text-slate-500">{item.phoneMasked ?? '—'}</p>
                  </td>
                  <td className={tdClass}>
                    <Badge tone={statusTone(item.status)}>{t(`status.${item.status}` as MessageKey)}</Badge>
                    {item.checkedInAt ? <p className="mt-1 text-xs text-slate-500">{formatTime(item.checkedInAt, lang)}</p> : null}
                  </td>
                  <td className={tdClass}>
                    <span className="text-xs text-slate-600">{t(`queue.source.${item.source}` as MessageKey)}</span>
                  </td>
                  <td className={tdClass}>
                    <div className="flex flex-wrap gap-2">
                      {item.status === 'booked' ? (
                        <Button size="sm" onClick={() => act(`/api/tokens/${item.id}/check-in`)}>
                          {t('queue.checkIn')}
                        </Button>
                      ) : null}
                      {item.status === 'booked' || item.status === 'checked_in' ? (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => act(`/api/tokens/${item.id}/no-show`)}>
                            {t('queue.markNoShow')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => cancel(item)}>
                            {t('queue.cancel')}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          ) : null}
        </Card>

        {doctorId && user?.role !== 'doctor' ? (
          <BookTokenForm
            key={doctorId + activeDate}
            doctorId={doctorId}
            date={activeDate}
            onBooked={(text) => {
              setNotice({ tone: 'success', text });
              queue.reload();
            }}
            onError={(text) => setNotice({ tone: 'error', text })}
          />
        ) : null}
      </div>
    </div>
  );
}

function BookTokenForm({
  doctorId,
  date,
  onBooked,
  onError,
}: {
  doctorId: string;
  date: string;
  onBooked: (text: string) => void;
  onError: (text: string) => void;
}) {
  const { t, errorText } = useI18n();
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [selected, setSelected] = useState<PatientHit | null>(null);
  const [creating, setCreating] = useState(false);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState<'phone' | 'walk_in'>('walk_in');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const query = search.trim();
    if (query.length < 2 || selected) {
      setHits([]);
      return;
    }
    const id = window.setTimeout(() => {
      api
        .get<PatientHit[]>(`/api/patients?q=${encodeURIComponent(query)}&limit=8`)
        .then(setHits)
        .catch(() => setHits([]));
    }, 300);
    return () => window.clearTimeout(id);
  }, [search, selected]);

  async function book(event: FormEvent) {
    event.preventDefault();
    if (!selected && !creating) return;
    setBusy(true);
    try {
      const result = await api.post<{ token: { tokenNumber: number }; notification: keyof typeof NOTIFY_KEYS }>('/api/tokens', {
        doctorId,
        date,
        source,
        notifyPatient: notify,
        patient: selected ? { patientId: selected.id } : { fullName, phone: phone || null },
      });
      const notifyText = t(NOTIFY_KEYS[result.notification]);
      onBooked(
        [t('queue.booked', { token: result.token.tokenNumber }), notifyText].filter(Boolean).join(' '),
      );
      setSelected(null);
      setSearch('');
      setCreating(false);
      setFullName('');
      setPhone('');
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = Boolean(selected) || (creating && fullName.trim().length >= 1);

  return (
    <Card title={t('queue.bookTitle')}>
      <form onSubmit={book} className="space-y-4" noValidate>
        {selected ? (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-teal-50 p-3 ring-1 ring-teal-200">
            <div className="min-w-0">
              <p className="text-xs text-teal-900">{t('queue.selectedPatient')}</p>
              <p className="truncate font-medium text-slate-900">{selected.fullName}</p>
              <p className="text-xs text-slate-600">{selected.phoneMasked ?? '—'}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setSelected(null)}>
              {t('queue.clearPatient')}
            </Button>
          </div>
        ) : creating ? (
          <div className="space-y-3">
            <Field id="newName" label={t('queue.fullName')}>
              <Input id="newName" value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={160} />
            </Field>
            <Field id="newPhone" label={t('queue.phoneOptional')}>
              <Input id="newPhone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Field id="patientSearch" label={t('queue.patientSearch')}>
              <Input id="patientSearch" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
            </Field>
            {hits.length > 0 ? (
              <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
                {hits.map((hit) => (
                  <li key={hit.id}>
                    <button type="button" onClick={() => setSelected(hit)} className="flex w-full min-h-11 items-center justify-between gap-3 px-3 py-2 text-start hover:bg-slate-50">
                      <span className="font-medium text-slate-900">{hit.fullName}</span>
                      <span className="text-xs text-slate-500">{hit.phoneMasked ?? '—'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : search.trim().length >= 2 ? (
              <p className="text-sm text-slate-600">{t('queue.noMatch')}</p>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
              {t('queue.newPatient')}
            </Button>
          </div>
        )}

        <Field id="bookSource" label={t('queue.source')}>
          <Select id="bookSource" value={source} onChange={(e) => setSource(e.target.value as 'phone' | 'walk_in')}>
            <option value="walk_in">{t('queue.source.walk_in')}</option>
            <option value="phone">{t('queue.source.phone')}</option>
          </Select>
        </Field>
        {source === 'phone' ? (
          <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" className="size-5 accent-teal-700" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            {t('queue.notify')}
          </label>
        ) : null}
        <Button type="submit" className="w-full" disabled={busy || !canSubmit}>
          {busy ? t('common.saving') : t('queue.book')}
        </Button>
      </form>
    </Card>
  );
}
