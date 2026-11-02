import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, ProgressBar, Spinner, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber } from '../../lib/format';
import { usePolling, useResource } from '../../lib/useResource';

interface Usage {
  period: string;
  notificationsSent: number;
  quota: number;
}

interface OutboundRow {
  id: string;
  kind: 'reply' | 'notification';
  templateKey: string;
  to: string;
  body: string;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  provider: string;
  createdAt: string;
  sentAt: string | null;
}

export function MessagesPage() {
  const { t, lang, errorText } = useI18n();
  const usage = useResource(() => api.get<Usage>('/api/clinic/usage'), []);
  const health = useResource(() => api.get<{ simulator: boolean }>('/api/health'), []);
  const messages = useResource(() => api.get<OutboundRow[]>('/api/messages?limit=50'), []);
  usePolling(() => messages.reload(), 5_000);

  const [phone, setPhone] = useState('');
  const [text, setText] = useState('BOOK');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function simulate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await api.post('/api/messages/simulate-inbound', { phone, text });
      setNotice({ tone: 'success', text: t('messages.simSent') });
      messages.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  const simulatorOn = health.data?.simulator ?? false;

  return (
    <div className="space-y-6">
      <PageHeader title={t('messages.title')} subtitle={t('messages.hint')} />

      {usage.data ? (
        <Card title={t('messages.usage')}>
          <ProgressBar value={usage.data.notificationsSent} max={usage.data.quota} label={t('messages.usage')} />
          <p className="mt-2 text-sm text-slate-700">
            {t('owner.quotaUsage', { sent: formatNumber(usage.data.notificationsSent, lang), quota: formatNumber(usage.data.quota, lang) })}
          </p>
        </Card>
      ) : null}

      {simulatorOn ? (
        <Card title={t('messages.simulatorTitle')}>
          <p className="-mt-2 mb-4 text-sm text-slate-600">{t('messages.simulatorNote')}</p>
          <form onSubmit={simulate} className="grid gap-4 sm:grid-cols-[1fr_2fr_auto] sm:items-end" noValidate>
            <Field id="simPhone" label={t('messages.simPhone')}>
              <Input id="simPhone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required placeholder="+91" />
            </Field>
            <Field id="simText" label={t('messages.simText')}>
              <Input id="simText" value={text} onChange={(e) => setText(e.target.value)} required maxLength={1000} />
            </Field>
            <Button type="submit" disabled={busy || !phone}>
              {busy ? t('common.saving') : t('messages.simSend')}
            </Button>
          </form>
          {notice ? <div className="mt-4"><Alert tone={notice.tone}>{notice.text}</Alert></div> : null}
        </Card>
      ) : health.data ? (
        <Alert tone="info">{t('messages.simDisabled')}</Alert>
      ) : null}

      <Card title={t('messages.title')}>
        {messages.loading && !messages.data ? <Spinner label={t('app.loading')} /> : null}
        {messages.error ? <Alert tone="error">{errorText(messages.error)}</Alert> : null}
        {messages.data && messages.data.length === 0 ? <EmptyState>{t('messages.empty')}</EmptyState> : null}
        {messages.data && messages.data.length > 0 ? (
          <Table head={[t('messages.sentAt'), t('messages.to'), t('messages.body'), t('common.status')]}>
            {messages.data.map((message) => (
              <tr key={message.id}>
                <td className={`${tdClass} whitespace-nowrap text-xs text-slate-600`}>{formatDateTime(message.createdAt, lang)}</td>
                <td className={`${tdClass} whitespace-nowrap`}>{message.to}</td>
                <td className={`${tdClass} max-w-md`}>
                  <p className="whitespace-pre-line break-words text-slate-800">{message.body}</p>
                  <span className="text-xs text-slate-500">{t(`messages.kind.${message.kind}`)}</span>
                  {message.lastError ? <p className="mt-1 text-xs text-red-700">{message.lastError}</p> : null}
                </td>
                <td className={tdClass}>
                  <Badge tone={message.status === 'sent' ? 'green' : message.status === 'failed' ? 'red' : 'amber'}>
                    {t(`messages.status.${message.status}`)}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        ) : null}
      </Card>
    </div>
  );
}
