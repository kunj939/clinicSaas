import type { Lang } from '../../i18n/languages';
import { useParams, Link } from 'react-router-dom';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import { api, reportFileUrl } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useResource } from '../../lib/useResource';
import { statusTone } from './status';
import type { QueueItem } from '../reception/QueuePage';

interface PatientToken {
  id: string;
  date: string;
  tokenNumber: number;
  status: QueueItem['status'];
  doctorName: string;
}

interface PatientDetail {
  id: string;
  fullName: string;
  phone?: string;
  phoneMasked: string | null;
  gender: string | null;
  ageYears: number | null;
  preferredLanguage: Lang;
  tokens: PatientToken[];
  openFollowUps: { id: string; dueDate: string; reason: string | null; doctorName: string }[];
  reports: { id: string; title: string; status: 'draft' | 'ready'; doctorName: string; createdAt: string; readyAt: string | null }[];
}

export function PatientDetailPage() {
  const { id } = useParams();
  const { t, lang, errorText } = useI18n();
  const patient = useResource(() => api.get<PatientDetail>(`/api/patients/${id}`), [id]);

  if (patient.loading && !patient.data) return <Spinner label={t('app.loading')} />;
  if (patient.error || !patient.data) return <Alert tone="error">{errorText(patient.error)}</Alert>;
  const data = patient.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={data.fullName}
        subtitle={[data.phone ?? data.phoneMasked, data.ageYears ? `${data.ageYears}` : null, data.gender ? t(`patients.gender.${data.gender}` as MessageKey) : null]
          .filter(Boolean)
          .join(' · ')}
        actions={<Link to="/app/patients" className="text-sm font-medium text-teal-800 underline">{t('nav.patients')}</Link>}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t('patients.tokens')}>
          {data.tokens.length === 0 ? (
            <EmptyState>{t('patients.noTokens')}</EmptyState>
          ) : (
            <Table head={[t('common.date'), t('queue.tokenNumber'), t('common.status'), t('doctors.name')]}>
              {data.tokens.map((token) => (
                <tr key={token.id}>
                  <td className={`${tdClass} whitespace-nowrap`}>{formatDate(token.date, lang)}</td>
                  <td className={tdClass}>{token.tokenNumber}</td>
                  <td className={tdClass}>
                    <Badge tone={statusTone(token.status)}>{t(`status.${token.status}` as MessageKey)}</Badge>
                  </td>
                  <td className={tdClass}>{token.doctorName}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title={t('patients.followUps')}>
          {data.openFollowUps.length === 0 ? (
            <EmptyState>{t('patients.noFollowUps')}</EmptyState>
          ) : (
            <ul className="space-y-3 text-sm">
              {data.openFollowUps.map((followUp) => (
                <li key={followUp.id} className="rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
                  <p className="font-medium text-slate-900">{formatDate(followUp.dueDate, lang)}</p>
                  <p className="text-slate-700">{followUp.reason ?? '—'}</p>
                  <p className="text-xs text-slate-600">{t('patients.doctorWith', { name: followUp.doctorName })}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t('patients.reports')} className="lg:col-span-2">
          {data.reports.length === 0 ? (
            <EmptyState>{t('patients.noReports')}</EmptyState>
          ) : (
            <Table head={[t('common.name'), t('common.status'), t('doctors.name'), t('common.created'), '']}>
              {data.reports.map((report) => (
                <tr key={report.id}>
                  <td className={`${tdClass} font-medium`}>{report.title}</td>
                  <td className={tdClass}>
                    <Badge tone={report.status === 'ready' ? 'green' : 'slate'}>
                      {report.status === 'ready' ? t('patients.ready') : t('patients.draft')}
                    </Badge>
                  </td>
                  <td className={tdClass}>{report.doctorName}</td>
                  <td className={`${tdClass} whitespace-nowrap`}>{formatDate(report.createdAt.slice(0, 10), lang)}</td>
                  <td className={tdClass}>
                    <a href={reportFileUrl(report.id)} target="_blank" rel="noreferrer" className="font-medium text-teal-800 underline">
                      {t('patients.open')}
                    </a>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
