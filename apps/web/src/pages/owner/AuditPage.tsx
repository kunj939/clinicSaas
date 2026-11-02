import { useState } from 'react';
import { Alert, Button, Card, EmptyState, PageHeader, Spinner, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import { api } from '../../lib/api';
import { useResource } from '../../lib/useResource';

interface AuditItem {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  actorName: string | null;
  createdAt: string;
}

interface AuditPage {
  items: AuditItem[];
  nextCursor: number | null;
}

export function AuditPage() {
  const { t, lang, errorText } = useI18n();
  const [older, setOlder] = useState<AuditItem[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const first = useResource(() => api.get<AuditPage>('/api/audit-logs?limit=50'), []);

  const nextCursor = cursor !== undefined ? cursor : first.data?.nextCursor ?? null;
  const items = [...(first.data?.items ?? []), ...older];

  async function loadMore() {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.get<AuditPage>(`/api/audit-logs?limit=50&before=${nextCursor}`);
      setOlder((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (error) {
      setMoreError(errorText(error));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('audit.title')} subtitle={t('audit.hint')} />
      <Card>
        {first.loading && !first.data ? <Spinner label={t('app.loading')} /> : null}
        {first.error ? <Alert tone="error">{errorText(first.error)}</Alert> : null}
        {first.data && items.length === 0 ? <EmptyState>{t('audit.empty')}</EmptyState> : null}
        {items.length > 0 ? (
          <Table head={[t('common.time'), t('audit.actor'), t('audit.action'), t('audit.entity')]}>
            {items.map((item) => (
              <tr key={item.id}>
                <td className={`${tdClass} whitespace-nowrap`}>{formatDateTime(item.createdAt, lang)}</td>
                <td className={tdClass}>{item.actorName ?? t('audit.system')}</td>
                <td className={tdClass}>
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{item.action}</code>
                  {Object.keys(item.metadata).length > 0 ? (
                    <span className="ms-2 text-xs text-slate-500">
                      {Object.entries(item.metadata)
                        .map(([key, value]) => `${key}: ${String(value)}`)
                        .join(' · ')}
                    </span>
                  ) : null}
                </td>
                <td className={`${tdClass} text-xs text-slate-500`}>{item.entityType}</td>
              </tr>
            ))}
          </Table>
        ) : null}
        {moreError ? <Alert tone="error">{moreError}</Alert> : null}
        {nextCursor !== null && items.length > 0 ? (
          <div className="mt-4">
            <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? t('common.searching') : t('common.loadMore')}
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
