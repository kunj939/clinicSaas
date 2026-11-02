import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Spinner, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { useResource } from '../../lib/useResource';

interface Doctor {
  id: string;
  name: string;
  specialization: string | null;
  isActive: boolean;
  workingDays: number[];
}

interface ScheduleDay {
  weekday: number;
  startTime: string;
  endTime: string;
  maxTokens: number;
  isActive: boolean;
}

interface DayDraft {
  weekday: number;
  enabled: boolean;
  startTime: string;
  endTime: string;
  maxTokens: string;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

function toDrafts(days: ScheduleDay[]): DayDraft[] {
  return WEEKDAYS.map((weekday) => {
    const existing = days.find((day) => day.weekday === weekday);
    return {
      weekday,
      enabled: Boolean(existing?.isActive),
      startTime: existing?.startTime ?? '10:00',
      endTime: existing?.endTime ?? '13:00',
      maxTokens: String(existing?.maxTokens ?? 30),
    };
  });
}

export function DoctorsPage() {
  const { t, errorText } = useI18n();
  const doctors = useResource(() => api.get<Doctor[]>('/api/doctors'), []);
  const [name, setName] = useState('');
  const [specialization, setSpecialization] = useState('');
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function addDoctor(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api.post('/api/doctors', { name, specialization: specialization || null });
      setName('');
      setSpecialization('');
      setNotice({ tone: 'success', text: t('doctors.created') });
      doctors.reload();
    } catch (reason) {
      setNotice({ tone: 'error', text: errorText(reason) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(doctor: Doctor) {
    try {
      await api.patch(`/api/doctors/${doctor.id}`, { isActive: !doctor.isActive });
      doctors.reload();
    } catch (reason) {
      setNotice({ tone: 'error', text: errorText(reason) });
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('doctors.title')} />
      {notice ? (
        <Alert tone={notice.tone} onDismiss={() => setNotice(null)} dismissLabel={t('common.dismiss')}>
          {notice.text}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title={t('nav.doctors')}>
            {doctors.loading && !doctors.data ? <Spinner label={t('app.loading')} /> : null}
            {doctors.data && doctors.data.length === 0 ? <EmptyState>{t('doctors.noDoctors')}</EmptyState> : null}
            {doctors.data && doctors.data.length > 0 ? (
              <Table head={[t('common.name'), t('doctors.workingDays'), t('common.status'), t('common.actions')]}>
                {doctors.data.map((doctor) => (
                  <tr key={doctor.id}>
                    <td className={tdClass}>
                      <p className="font-medium text-slate-900">{doctor.name}</p>
                      {doctor.specialization ? <p className="text-xs text-slate-500">{doctor.specialization}</p> : null}
                    </td>
                    <td className={tdClass}>
                      {doctor.workingDays.length === 0 ? (
                        <span className="text-slate-500">{t('doctors.noWorkingDays')}</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {doctor.workingDays.map((day) => (
                            <Badge key={day} tone="teal">
                              {t(`doctors.weekday.${day}` as 'doctors.weekday.0')}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className={tdClass}>
                      <Badge tone={doctor.isActive ? 'green' : 'slate'}>{doctor.isActive ? t('common.active') : t('common.inactive')}</Badge>
                    </td>
                    <td className={tdClass}>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setSelectedId(doctor.id)}>
                          {t('doctors.selectDoctor')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => toggleActive(doctor)}>
                          {doctor.isActive ? t('common.deactivate') : t('common.activate')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </Table>
            ) : null}
          </Card>

          {selectedId ? <ScheduleEditor doctorId={selectedId} doctorName={doctors.data?.find((d) => d.id === selectedId)?.name ?? ''} onSaved={doctors.reload} /> : null}
        </div>

        <Card title={t('doctors.add')}>
          <form onSubmit={addDoctor} className="space-y-4" noValidate>
            <Field id="doctorName" label={t('doctors.name')}>
              <Input id="doctorName" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={160} />
            </Field>
            <Field id="specialization" label={`${t('doctors.specialization')} (${t('common.optional')})`}>
              <Input id="specialization" value={specialization} onChange={(e) => setSpecialization(e.target.value)} maxLength={120} />
            </Field>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? t('common.adding') : t('doctors.add')}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function ScheduleEditor({ doctorId, doctorName, onSaved }: { doctorId: string; doctorName: string; onSaved: () => void }) {
  const { t, errorText } = useI18n();
  const schedule = useResource(() => api.get<ScheduleDay[]>(`/api/doctors/${doctorId}/schedule`), [doctorId]);
  const [drafts, setDrafts] = useState<DayDraft[] | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const current = drafts ?? (schedule.data ? toDrafts(schedule.data) : null);

  function update(weekday: number, patch: Partial<DayDraft>) {
    if (!current) return;
    setDrafts(current.map((day) => (day.weekday === weekday ? { ...day, ...patch } : day)));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!current) return;
    setBusy(true);
    setNotice(null);
    try {
      const days = current
        .filter((day) => day.enabled)
        .map((day) => ({
          weekday: day.weekday,
          startTime: day.startTime,
          endTime: day.endTime,
          maxTokens: Number(day.maxTokens),
          isActive: true,
        }));
      await api.put(`/api/doctors/${doctorId}/schedule`, { days });
      setNotice({ tone: 'success', text: t('doctors.scheduleSaved') });
      setDrafts(null);
      schedule.reload();
      onSaved();
    } catch (reason) {
      setNotice({ tone: 'error', text: errorText(reason) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('doctors.scheduleFor', { name: doctorName })}>
      <p className="-mt-2 mb-4 text-sm text-slate-600">{t('doctors.scheduleHint')}</p>
      {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      {schedule.loading && !current ? <Spinner label={t('app.loading')} /> : null}
      {current ? (
        <form onSubmit={save} className="mt-4 space-y-3">
          {current.map((day) => (
            <fieldset key={day.weekday} className="grid items-end gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[minmax(9rem,1fr)_auto_auto_auto] sm:border-0 sm:p-0">
              <legend className="sr-only">{t(`doctors.weekday.${day.weekday}` as 'doctors.weekday.0')}</legend>
              <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-800">
                <input
                  type="checkbox"
                  className="size-5 accent-teal-700"
                  checked={day.enabled}
                  onChange={(e) => update(day.weekday, { enabled: e.target.checked })}
                />
                {t(`doctors.weekday.${day.weekday}` as 'doctors.weekday.0')}
              </label>
              <Field id={`start-${day.weekday}`} label={t('doctors.start')}>
                <Input id={`start-${day.weekday}`} type="time" value={day.startTime} disabled={!day.enabled} onChange={(e) => update(day.weekday, { startTime: e.target.value })} />
              </Field>
              <Field id={`end-${day.weekday}`} label={t('doctors.end')}>
                <Input id={`end-${day.weekday}`} type="time" value={day.endTime} disabled={!day.enabled} onChange={(e) => update(day.weekday, { endTime: e.target.value })} />
              </Field>
              <Field id={`max-${day.weekday}`} label={t('doctors.maxTokens')}>
                <Input
                  id={`max-${day.weekday}`}
                  type="number"
                  min={1}
                  max={500}
                  value={day.maxTokens}
                  disabled={!day.enabled}
                  onChange={(e) => update(day.weekday, { maxTokens: e.target.value })}
                />
              </Field>
            </fieldset>
          ))}
          <Button type="submit" disabled={busy}>
            {busy ? t('common.saving') : t('doctors.saveSchedule')}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
