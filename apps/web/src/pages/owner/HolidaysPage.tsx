import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Spinner, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import { formatDate } from '../../lib/format';
import { api } from '../../lib/api';
import { useResource } from '../../lib/useResource';

interface Holiday {
  id: string;
  date: string;
  reason: string | null;
}

export function HolidaysPage() {
  const { t, lang, errorText } = useI18n();
  const holidays = useResource(() => api.get<Holiday[]>('/api/holidays'), []);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api.post('/api/holidays', { date, reason: reason || null });
      setDate('');
      setReason('');
      setNotice({ tone: 'success', text: t('holidays.added') });
      holidays.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.delete(`/api/holidays/${id}`);
      holidays.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('holidays.title')} subtitle={t('holidays.hint')} />
      {notice ? <Alert tone={notice.tone} onDismiss={() => setNotice(null)} dismissLabel={t('common.dismiss')}>{notice.text}</Alert> : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={t('holidays.title')} className="lg:col-span-2">
          {holidays.loading && !holidays.data ? <Spinner label={t('app.loading')} /> : null}
          {holidays.data && holidays.data.length === 0 ? <EmptyState>{t('holidays.empty')}</EmptyState> : null}
          {holidays.data && holidays.data.length > 0 ? (
            <Table head={[t('common.date'), t('common.reason'), t('common.actions')]}>
              {holidays.data.map((holiday) => (
                <tr key={holiday.id}>
                  <td className={tdClass}>{formatDate(holiday.date, lang)}</td>
                  <td className={tdClass}>{holiday.reason ?? '—'}</td>
                  <td className={tdClass}>
                    <Button size="sm" variant="ghost" onClick={() => remove(holiday.id)}>
                      {t('common.remove')}
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          ) : null}
        </Card>
        <Card title={t('holidays.add')}>
          <form onSubmit={add} className="space-y-4" noValidate>
            <Field id="holidayDate" label={t('common.date')}>
              <Input id="holidayDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            <Field id="holidayReason" label={`${t('common.reason')} (${t('common.optional')})`}>
              <Input id="holidayReason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={160} />
            </Field>
            <Button type="submit" className="w-full" disabled={busy || !date}>
              {busy ? t('common.adding') : t('holidays.add')}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
