import type { Lang } from '../i18n';

const locales: Record<Lang, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  bn: 'bn-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  kn: 'kn-IN',
  pa: 'pa-IN',
};

/** "2026-10-31" is a calendar date, so it is built as a local date instead of parsed as UTC. */
function parseCalendarDate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1);
}

export function formatDate(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locales[lang], { day: '2-digit', month: 'short', year: 'numeric' }).format(
    parseCalendarDate(iso),
  );
}

export function formatDateTime(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locales[lang], {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatTime(iso: string | null, lang: Lang): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locales[lang], { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** Local calendar date as YYYY-MM-DD, used only as a fallback before the server sends the clinic's date. */
export function localIsoDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(iso: string, days: number): string {
  const date = parseCalendarDate(iso);
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

export function formatNumber(value: number, lang: Lang): string {
  return new Intl.NumberFormat(locales[lang]).format(value);
}
