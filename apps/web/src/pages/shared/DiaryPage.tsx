import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Stat, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import { api } from '../../lib/api';
import { formatDate, formatNumber } from '../../lib/format';
import { useResource } from '../../lib/useResource';
import type { QueueItem } from '../reception/QueuePage';
import { statusTone } from './status';
import { useClinicToday } from './useClinicToday';

/** Methods staff can record by hand. 'online' is set only by a successful PayU payment. */
type Method = 'cash' | 'upi' | 'card' | 'other' | 'online';
const METHODS: Method[] = ['cash', 'upi', 'card', 'other'];
const METHOD_KEY: Record<Method, MessageKey> = {
  cash: 'payment.cash',
  upi: 'payment.upi',
  card: 'payment.card',
  other: 'payment.other',
  online: 'payment.online',
};

interface DiaryEntry {
  tokenId: string;
  tokenNumber: number;
  status: string;
  source: string;
  doctorId: string;
  doctorName: string;
  patientId: string;
  patientName: string;
  phone: string | null;
  diagnosis: string | null;
  prescription: string | null;
  medicineDays: number | null;
  followUpDate: string | null;
  feeAmount: number | null;
  amountPaid: number | null;
  paymentMethod: Method | null;
}

interface DiaryDto {
  date: string;
  entries: DiaryEntry[];
  summary: { patientsSeen: number; collected: number; due: number; byMethod: Record<Method, number> };
}

type Notice = { tone: 'error' | 'success'; text: string };

/** The day's register. Replaces the paper diary: who came, what they were given, when to come next and what was paid. */
export function DiaryPage() {
  const { t, lang, errorText } = useI18n();
  const today = useClinicToday();
  const [date, setDate] = useState<string | null>(null);
  const activeDate = date ?? today;
  const diary = useResource(() => api.get<DiaryDto>(`/api/diary?date=${activeDate}`), [activeDate]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const money = (value: number) => `₹${formatNumber(value, lang)}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('diary.title')}
        subtitle={t('diary.subtitle')}
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            {t('diary.print')}
          </Button>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <Field id="diaryDate" label={t('common.date')}>
            <Input id="diaryDate" type="date" className="sm:w-56!" value={activeDate} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Button variant="ghost" onClick={() => setDate(today)} disabled={activeDate === today}>
            {t('common.today')}
          </Button>
        </div>
      </Card>

      {notice ? (
        <Alert tone={notice.tone} onDismiss={() => setNotice(null)} dismissLabel={t('common.dismiss')}>
          {notice.text}
        </Alert>
      ) : null}
      {diary.error ? <Alert tone="error">{errorText(diary.error)}</Alert> : null}
      {diary.loading && !diary.data ? <Spinner label={t('app.loading')} /> : null}

      {diary.data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label={t('diary.seen')} value={formatNumber(diary.data.summary.patientsSeen, lang)} />
            <Stat label={t('diary.collected')} value={money(diary.data.summary.collected)} hint={methodHint(diary.data.summary.byMethod, t, money)} />
            <Stat label={t('diary.due')} value={money(diary.data.summary.due)} />
          </div>

          <Card title={formatDate(activeDate, lang)}>
            {diary.data.entries.length === 0 ? (
              <EmptyState>{t('diary.empty')}</EmptyState>
            ) : (
              <Table
                head={[
                  t('queue.tokenNumber'),
                  t('queue.patient'),
                  t('doctors.title'),
                  t('diary.medicine'),
                  t('diary.nextVisit'),
                  t('diary.notes'),
                  t('diary.payment'),
                ]}
              >
                {diary.data.entries.map((entry) => (
                  <DiaryRow
                    key={entry.tokenId}
                    entry={entry}
                    onSaved={() => {
                      setNotice({ tone: 'success', text: t('diary.saved') });
                      diary.reload();
                    }}
                    onError={(text) => setNotice({ tone: 'error', text })}
                  />
                ))}
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

function methodHint(byMethod: Record<Method, number>, t: (key: MessageKey) => string, money: (value: number) => string): string {
  return (Object.keys(METHOD_KEY) as Method[]).filter((method) => byMethod[method] > 0)
    .map((method) => `${t(METHOD_KEY[method])} ${money(byMethod[method])}`)
    .join(' · ');
}

function DiaryRow({
  entry,
  onSaved,
  onError,
}: {
  entry: DiaryEntry;
  onSaved: () => void;
  onError: (text: string) => void;
}) {
  const { t, lang } = useI18n();
  const [editing, setEditing] = useState(false);
  const paid = entry.amountPaid !== null && entry.amountPaid > 0;

  return (
    <>
      <tr>
        <td className={`${tdClass} text-lg font-semibold`}>{entry.tokenNumber}</td>
        <td className={tdClass}>
          <p className="font-medium text-slate-900">{entry.patientName}</p>
          <p className="text-xs text-slate-500">{entry.phone ?? '—'}</p>
          <Badge tone={statusTone(entry.status as QueueItem["status"])}>{t(`status.${entry.status}` as MessageKey)}</Badge>
        </td>
        <td className={tdClass}>{entry.doctorName}</td>
        <td className={tdClass}>{entry.medicineDays ? t('doctor.daysChip', { n: entry.medicineDays }) : '—'}</td>
        <td className={tdClass}>{entry.followUpDate ? formatDate(entry.followUpDate, lang) : '—'}</td>
        <td className={`${tdClass} max-w-xs`}>
          <p className="line-clamp-2 text-sm text-slate-700">{entry.diagnosis ?? entry.prescription ?? '—'}</p>
        </td>
        <td className={tdClass}>
          <p className="text-sm">
            {entry.feeAmount !== null ? `₹${formatNumber(entry.feeAmount, lang)}` : '—'}
            {paid ? ` · ${t('diary.paidShort')} ₹${formatNumber(entry.amountPaid ?? 0, lang)}` : ''}
          </p>
          {entry.paymentMethod ? <p className="text-xs text-slate-500">{t(METHOD_KEY[entry.paymentMethod])}</p> : null}
          <Button variant="ghost" size="sm" className="mt-1 px-0" onClick={() => setEditing((value) => !value)} aria-expanded={editing}>
            {editing ? t('common.close') : t('diary.editPayment')}
          </Button>
        </td>
      </tr>
      {editing ? (
        <tr className="bg-slate-50">
          <td colSpan={7} className="p-4">
            <PaymentForm
              entry={entry}
              onSaved={() => {
                setEditing(false);
                onSaved();
              }}
              onError={onError}
            />
            <PaymentLink entry={entry} onError={onError} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function PaymentForm({ entry, onSaved, onError }: { entry: DiaryEntry; onSaved: () => void; onError: (text: string) => void }) {
  const { t, errorText } = useI18n();
  const [fee, setFee] = useState(entry.feeAmount === null ? '' : String(entry.feeAmount));
  const [paid, setPaid] = useState(entry.amountPaid === null ? '' : String(entry.amountPaid));
  const [method, setMethod] = useState<Method | ''>(entry.paymentMethod ?? '');
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    const paidAmount = paid === '' ? null : Number(paid);
    if (paidAmount && !method) {
      onError(t('diary.chooseMethod'));
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/tokens/${entry.tokenId}/payment`, {
        feeAmount: fee === '' ? null : Number(fee),
        amountPaid: paidAmount,
        paymentMethod: method || null,
      });
      onSaved();
    } catch (reason) {
      onError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-wrap items-end gap-4" noValidate>
      <Field id={`fee-${entry.tokenId}`} label={t('diary.fee')}>
        <Input id={`fee-${entry.tokenId}`} type="number" inputMode="numeric" min={0} className="w-32!" value={fee} onChange={(e) => setFee(e.target.value)} />
      </Field>
      <Field id={`paid-${entry.tokenId}`} label={t('diary.paid')}>
        <Input id={`paid-${entry.tokenId}`} type="number" inputMode="numeric" min={0} className="w-32!" value={paid} onChange={(e) => setPaid(e.target.value)} />
      </Field>
      <Field id={`method-${entry.tokenId}`} label={t('diary.method')}>
        <Select id={`method-${entry.tokenId}`} className="w-40!" value={method} onChange={(e) => setMethod(e.target.value as Method | '')}>
          <option value="">{t('common.select')}</option>
          {METHODS.map((item) => (
            <option key={item} value={item}>
              {t(METHOD_KEY[item])}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={busy}>
        {busy ? t('common.saving') : t('diary.savePayment')}
      </Button>
    </form>
  );
}

/** Makes a PayU payment link for the amount still due. The patient opens it on their phone and pays on PayU's page. */
function PaymentLink({ entry, onError }: { entry: DiaryEntry; onError: (text: string) => void }) {
  const { t, errorText, lang } = useI18n();
  const [link, setLink] = useState<{ payUrl: string; amount: number; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    try {
      setLink(await api.post<{ payUrl: string; amount: number; expiresAt: string }>('/api/payments/requests', { tokenId: entry.tokenId }));
    } catch (reason) {
      onError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  return (
    <div className="mt-4 border-t border-slate-200 pt-4">
      <p className="text-sm font-medium text-slate-800">{t('diary.linkTitle')}</p>
      <p className="mt-1 text-sm text-slate-600">{t('diary.linkHint')}</p>
      {link ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-slate-700">
            ₹{formatNumber(link.amount, lang)} · {t('diary.linkValidUntil', { date: formatDate(link.expiresAt.slice(0, 10), lang) })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label={t('diary.linkTitle')} readOnly value={link.payUrl} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 sm:w-96!" />
            <Button variant="secondary" size="sm" onClick={() => void copy(link.payUrl)}>
              {copied ? t('common.copied') : t('common.copy')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => void create()} disabled={busy}>
          {busy ? t('common.saving') : t('diary.createLink')}
        </Button>
      )}
    </div>
  );
}
