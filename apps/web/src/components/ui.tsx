import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { IconBadge, type IconName } from './icons';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'light' | 'outlineLight';

/** Each variant is a complete look. Pages should pick a variant rather than override its colours with className. */
const variantClass: Record<Variant, string> = {
  primary: 'bg-teal-700 text-white shadow-sm hover:bg-teal-800 focus-visible:outline-teal-700 disabled:bg-teal-300 disabled:shadow-none',
  secondary: 'bg-white text-slate-800 shadow-sm ring-1 ring-inset ring-slate-200 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 focus-visible:outline-red-600 disabled:bg-red-300',
  ghost: 'text-teal-800 hover:bg-teal-50 disabled:text-slate-400',
  /** For dark backgrounds: solid white with dark teal text. */
  light: 'bg-white text-teal-900 shadow-sm hover:bg-teal-50 focus-visible:outline-white',
  /** For dark backgrounds: transparent with a white outline. */
  outlineLight: 'bg-transparent text-white ring-1 ring-inset ring-white/40 hover:bg-white/10 focus-visible:outline-white',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed active:scale-[0.99]',
        size === 'sm' ? 'min-h-9 px-3 text-sm' : 'min-h-11 px-4 text-sm sm:text-base',
        variantClass[variant],
        className,
      )}
      {...rest}
    />
  );
}

const controlClass =
  'block w-full min-h-11 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-base text-slate-900 shadow-sm placeholder:text-slate-400 transition-colors focus:border-teal-600 focus:outline-2 focus:outline-teal-600/30 aria-[invalid=true]:border-red-600 disabled:bg-slate-100';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(controlClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(controlClass, 'min-h-24', className)} {...props} />;
}

export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-sm text-slate-500">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-900/5 sm:p-6', className)}>
      {title || actions ? (
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          {title ? <h2 className="text-base font-semibold text-slate-900 sm:text-lg">{title}</h2> : <span />}
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-600">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

const toneClass = {
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  teal: 'bg-teal-50 text-teal-800 ring-teal-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-800 ring-red-200',
  blue: 'bg-blue-50 text-blue-800 ring-blue-200',
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
} as const;

export function Badge({ tone = 'slate', children }: { tone?: keyof typeof toneClass; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', toneClass[tone])}>{children}</span>
  );
}

export function Alert({
  tone = 'info',
  children,
  onDismiss,
  dismissLabel,
}: {
  tone?: 'error' | 'success' | 'info';
  children: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  const styles = {
    error: 'bg-red-50 text-red-900 ring-red-200',
    success: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
    info: 'bg-sky-50 text-sky-900 ring-sky-200',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start justify-between gap-3 rounded-xl p-3.5 text-sm ring-1 ring-inset', styles)}>
      <div className="min-w-0 break-words">{children}</div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="shrink-0 rounded px-2 py-0.5 font-medium underline-offset-2 hover:underline">
          {dismissLabel ?? 'OK'}
        </button>
      ) : null}
    </div>
  );
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-5 overflow-x-auto sm:-mx-6">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50/80">
          <tr>
            {head.map((item, index) => (
              <th key={index} scope="col" className="whitespace-nowrap px-4 py-2.5 text-start text-xs font-semibold uppercase tracking-wide text-slate-500 first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6">
                {item}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white [&>tr]:transition-colors [&>tr:hover]:bg-slate-50/70">{children}</tbody>
      </table>
    </div>
  );
}

export const tdClass = 'px-4 py-3.5 align-top text-slate-800 first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6';

export function EmptyState({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-10 text-center text-sm text-slate-600">
      {icon ? <IconBadge name={icon} tone="slate" /> : null}
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: IconName;
  tone?: 'teal' | 'amber' | 'blue' | 'green' | 'slate';
}) {
  return (
    <div className="flex items-start gap-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-900/5">
      {icon ? <IconBadge name={icon} tone={tone} /> : null}
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
        {hint ? <p className="mt-1 truncate text-xs text-slate-500">{hint}</p> : null}
      </div>
    </div>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={cn('h-full rounded-full transition-all', percent >= 90 ? 'bg-red-500' : 'bg-gradient-to-r from-teal-500 to-teal-700')} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** The product mark. Use it everywhere the app name appears so the public site and the app look like one product. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn('grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-teal-500 to-teal-800 text-white shadow-sm', className)}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-slate-600">
      <span className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
