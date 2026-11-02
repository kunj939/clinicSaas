import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { type Clinic, useAuth } from '../auth/AuthContext';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { api } from '../lib/api';

/** Monday first, the way clinics usually think about their week. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const DAY_KEYS: Record<number, MessageKey> = {
  0: 'doctors.weekday.0',
  1: 'doctors.weekday.1',
  2: 'doctors.weekday.2',
  3: 'doctors.weekday.3',
  4: 'doctors.weekday.4',
  5: 'doctors.weekday.5',
  6: 'doctors.weekday.6',
};

interface DayRow {
  weekday: number;
  enabled: boolean;
  startTime: string;
  endTime: string;
  maxTokens: number;
}

/** Mon to Sat open with a sensible default; Sunday starts closed. */
function defaultRows(): DayRow[] {
  return WEEK_ORDER.map((weekday) => ({
    weekday,
    enabled: weekday !== 0,
    startTime: '10:00',
    endTime: '14:00',
    maxTokens: 25,
  }));
}

/** First-run screen for a single-doctor clinic: one form creates the clinic, the doctor and their hours. */
export function OnboardingPage() {
  const { t, errorText, lang } = useI18n();
  const { setClinic } = useAuth();
  const navigate = useNavigate();
  const [clinicName, setClinicName] = useState('');
  const [doctorName, setDoctorName] = useState('');
  const [cutoff, setCutoff] = useState('20:00');
  const [rows, setRows] = useState<DayRow[]>(defaultRows);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function updateRow(weekday: number, patch: Partial<DayRow>) {
    setRows((current) => current.map((row) => (row.weekday === weekday ? { ...row, ...patch } : row)));
  }

  function firstProblem(): string | null {
    const open = rows.filter((row) => row.enabled);
    if (clinicName.trim().length < 2) return t('onboarding.errClinicName');
    if (doctorName.trim().length < 2) return t('onboarding.errDoctorName');
    if (open.length === 0) return t('onboarding.errNoDay');
    if (open.some((row) => row.endTime <= row.startTime)) return t('onboarding.errTimes');
    if (open.some((row) => !(row.maxTokens >= 1))) return t('onboarding.errPatients');
    return null;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = firstProblem();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const clinic = await api.post<Clinic>('/api/clinic/setup', {
        clinicName: clinicName.trim(),
        doctorName: doctorName.trim(),
        defaultLanguage: lang,
        bookingCutoffTime: cutoff,
        days: rows
          .filter((row) => row.enabled)
          .map(({ weekday, startTime, endTime, maxTokens }) => ({ weekday, startTime, endTime, maxTokens, isActive: true })),
      });
      setClinic(clinic);
      navigate('/app/reception', { replace: true });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Card title={t('onboarding.title')}>
        <p className="-mt-2 mb-5 text-sm text-slate-600">{t('onboarding.subtitle')}</p>
        <form onSubmit={onSubmit} className="space-y-6" noValidate>
          {error ? <Alert tone="error">{error}</Alert> : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="clinicName" label={t('onboarding.clinicName')}>
              <Input id="clinicName" autoComplete="organization" value={clinicName} onChange={(e) => setClinicName(e.target.value)} maxLength={160} />
            </Field>
            <Field id="doctorName" label={t('onboarding.doctorName')}>
              <Input id="doctorName" autoComplete="off" value={doctorName} onChange={(e) => setDoctorName(e.target.value)} maxLength={160} />
            </Field>
          </div>

          <section aria-labelledby="hours-title" className="space-y-3">
            <div>
              <h3 id="hours-title" className="text-base font-semibold text-slate-900">
                {t('onboarding.hoursTitle')}
              </h3>
              <p className="text-sm text-slate-600">{t('onboarding.hoursHint')}</p>
            </div>
            <ul className="divide-y divide-slate-200 rounded-lg ring-1 ring-slate-200">
              {rows.map((row) => {
                const dayName = t(DAY_KEYS[row.weekday]!);
                return (
                  <li key={row.weekday} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
                    <label className="flex min-h-11 w-28 items-center gap-2 text-base font-medium text-slate-800">
                      <input
                        type="checkbox"
                        className="size-5 accent-teal-700"
                        checked={row.enabled}
                        onChange={(e) => updateRow(row.weekday, { enabled: e.target.checked })}
                      />
                      {dayName}
                    </label>
                    <div className={row.enabled ? 'flex flex-wrap items-center gap-3' : 'flex flex-wrap items-center gap-3 opacity-50'}>
                      <label className="flex items-center gap-2 text-sm text-slate-600">
                        {t('onboarding.from')}
                        <Input
                          type="time"
                          aria-label={`${dayName} ${t('onboarding.from')}`}
                          className="w-32!"
                          value={row.startTime}
                          disabled={!row.enabled}
                          onChange={(e) => updateRow(row.weekday, { startTime: e.target.value })}
                        />
                      </label>
                      <label className="flex items-center gap-2 text-sm text-slate-600">
                        {t('onboarding.to')}
                        <Input
                          type="time"
                          aria-label={`${dayName} ${t('onboarding.to')}`}
                          className="w-32!"
                          value={row.endTime}
                          disabled={!row.enabled}
                          onChange={(e) => updateRow(row.weekday, { endTime: e.target.value })}
                        />
                      </label>
                      <label className="flex items-center gap-2 text-sm text-slate-600">
                        {t('onboarding.patients')}
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={500}
                          aria-label={`${dayName} ${t('onboarding.patients')}`}
                          className="w-24!"
                          value={row.maxTokens}
                          disabled={!row.enabled}
                          onChange={(e) => updateRow(row.weekday, { maxTokens: Number(e.target.value) })}
                        />
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <Field id="cutoff" label={t('onboarding.cutoff')}>
            <Input id="cutoff" type="time" className="sm:w-40!" value={cutoff} onChange={(e) => setCutoff(e.target.value)} required />
          </Field>

          <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
            {busy ? t('common.saving') : t('onboarding.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
