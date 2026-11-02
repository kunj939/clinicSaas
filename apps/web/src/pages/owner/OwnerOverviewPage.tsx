import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Badge, Card, EmptyState, PageHeader, ProgressBar, Spinner, Stat, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import { formatNumber } from '../../lib/format';
import { api } from '../../lib/api';
import { useResource } from '../../lib/useResource';

interface Usage {
  period: string;
  notificationsSent: number;
  quota: number;
}

interface DoctorRow {
  id: string;
  name: string;
  isActive: boolean;
  workingDays: number[];
}

interface SummaryRow {
  doctorId: string;
  doctorName: string;
  capacity: number;
  activeCount: number;
  waiting: number;
  inConsultation: number;
  completed: number;
  noShow: number;
}

interface StaffRow {
  id: string;
}

interface HolidayRow {
  id: string;
}

export function OwnerOverviewPage() {
  const { t, lang, errorText } = useI18n();
  const { clinic } = useAuth();

  const overview = useResource(async () => {
    const today = await api.get<{ date: string }>('/api/clinic/today');
    const [usage, summary, doctors, staff, holidays] = await Promise.all([
      api.get<Usage>('/api/clinic/usage'),
      api.get<SummaryRow[]>(`/api/queue/summary?date=${today.date}`),
      api.get<DoctorRow[]>('/api/doctors'),
      api.get<StaffRow[]>('/api/staff'),
      api.get<HolidayRow[]>('/api/holidays'),
    ]);
    return { today: today.date, usage, summary, doctors, staff, holidays };
  }, []);

  if (overview.loading && !overview.data) return <Spinner label={t('app.loading')} />;
  if (overview.error || !overview.data) {
    return <Alert tone="error">{errorText(overview.error)}</Alert>;
  }

  const { today, usage, summary, doctors, staff, holidays } = overview.data;
  const activeDoctors = doctors.filter((doctor) => doctor.isActive);
  const tokensToday = summary.reduce((total, row) => total + row.activeCount, 0);
  const capacityToday = summary.reduce((total, row) => total + row.capacity, 0);
  const allScheduled = activeDoctors.length > 0 && activeDoctors.every((doctor) => doctor.workingDays.length > 0);

  const checks = [
    { label: t('owner.checkDoctor'), done: activeDoctors.length > 0 },
    { label: t('owner.checkSchedule'), done: allScheduled },
    { label: t('owner.checkWhatsapp'), done: Boolean(clinic?.whatsappPhoneNumberId) },
    { label: t('owner.checkStaff'), done: staff.length > 0 },
    { label: t('owner.checkHolidays'), done: holidays.length > 0 },
  ];
  const remaining = checks.filter((check) => !check.done).length;

  return (
    <div className="space-y-6">
      <PageHeader title={clinic?.name ?? t('owner.overviewTitle')} subtitle={t('owner.overviewTitle')} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label={t('owner.todayQueue')} value={`${formatNumber(tokensToday, lang)} / ${formatNumber(capacityToday, lang)}`} hint={today} />
        <Stat label={t('nav.doctors')} value={formatNumber(activeDoctors.length, lang)} />
        <Stat
          label={t('owner.quota')}
          value={formatNumber(usage.notificationsSent, lang)}
          hint={t('owner.quotaUsage', { sent: formatNumber(usage.notificationsSent, lang), quota: formatNumber(usage.quota, lang) })}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={t('owner.todayQueue')} className="lg:col-span-2">
          {doctors.length === 0 ? (
            <EmptyState>
              {t('owner.noDoctors')}{' '}
              <Link to="/app/owner/doctors" className="font-medium text-teal-800 underline">
                {t('doctors.add')}
              </Link>
            </EmptyState>
          ) : (
            <Table head={[t('doctors.name'), t('owner.capacityHeader'), t('queue.waiting'), t('queue.inConsultation'), t('queue.completed'), t('queue.noShow')]}>
              {summary.map((row) => (
                <tr key={row.doctorId}>
                  <td className={tdClass}>
                    <Link to={`/app/reception?doctor=${row.doctorId}`} className="font-medium text-teal-900 hover:underline">
                      {row.doctorName}
                    </Link>
                  </td>
                  <td className={tdClass}>
                    <div className="min-w-32 space-y-1">
                      <span className="text-xs text-slate-600">{t('queue.capacity', { active: row.activeCount, capacity: row.capacity })}</span>
                      <ProgressBar value={row.activeCount} max={row.capacity} label={row.doctorName} />
                    </div>
                  </td>
                  <td className={tdClass}>{formatNumber(row.waiting, lang)}</td>
                  <td className={tdClass}>{formatNumber(row.inConsultation, lang)}</td>
                  <td className={tdClass}>{formatNumber(row.completed, lang)}</td>
                  <td className={tdClass}>{formatNumber(row.noShow, lang)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <div className="space-y-6">
          <Card title={t('owner.checklist')} actions={<Badge tone={remaining === 0 ? 'green' : 'amber'}>{remaining === 0 ? t('owner.checkDone') : t('owner.checkTodo')}</Badge>}>
            <ul className="space-y-3 text-sm">
              {checks.map((check) => (
                <li key={check.label} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs ${check.done ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'}`}
                  >
                    {check.done ? '✓' : ''}
                  </span>
                  <span className="text-slate-800">{check.label}</span>
                </li>
              ))}
            </ul>
            {!clinic?.whatsappPhoneNumberId ? (
              <p className="mt-4 text-xs text-slate-600">{t('owner.notConnectedHint')}</p>
            ) : (
              <p className="mt-4 text-xs text-slate-600">{t('owner.connectedHint')}</p>
            )}
          </Card>

          <Card title={t('owner.quota')}>
            <ProgressBar value={usage.notificationsSent} max={usage.quota} label={t('owner.quota')} />
            <p className="mt-3 text-sm text-slate-700">
              {t('owner.quotaUsage', { sent: formatNumber(usage.notificationsSent, lang), quota: formatNumber(usage.quota, lang) })}
            </p>
            <p className="mt-2 text-xs text-slate-500">{t('owner.quotaNote')}</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
