import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n';
import { LanguageToggle } from './LanguageToggle';
import { BrandMark } from '../components/ui';

const POINTS = ['heroPoint1', 'heroPoint2', 'heroPoint3'] as const;

/**
 * Login and signup. On wide screens a brand panel explains the product beside the form;
 * on phones the form fills the screen and the brand sits in the header.
 */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="grid min-h-screen bg-slate-50 lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-teal-700 via-teal-800 to-slate-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-teal-400/20 blur-3xl" aria-hidden="true" />
        <Link to="/" className="relative flex items-center gap-2.5 font-semibold">
          <BrandMark />
          <span className="text-base">{t('app.name')}</span>
        </Link>
        <div className="relative max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">{t('landing.heroTitle')}</h2>
          <ul className="mt-8 space-y-4">
            {POINTS.map((key) => (
              <li key={key} className="flex items-start gap-3 text-teal-50">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-emerald-400/20 text-sm text-emerald-200" aria-hidden="true">
                  ✓
                </span>
                {t(`landing.${key}` as 'landing.heroPoint1')}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-teal-100/80">{t('landing.footer')}</p>
      </aside>

      <main className="flex flex-col">
        <header className="flex items-center justify-between gap-3 px-5 py-4 sm:px-8 lg:justify-end">
          <Link to="/" className="flex items-center gap-2.5 font-semibold text-slate-900 lg:hidden">
            <BrandMark className="size-8 rounded-lg" />
            <span className="text-sm">{t('app.name')}</span>
          </Link>
          <LanguageToggle />
        </header>
        <div className="flex flex-1 items-center justify-center px-5 pb-12 sm:px-8">
          <div className="w-full max-w-md">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
            {subtitle ? <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{subtitle}</p> : null}
            <div className="mt-7 rounded-2xl bg-white p-6 shadow-xl shadow-slate-900/5 ring-1 ring-slate-900/5 sm:p-8">{children}</div>
          </div>
        </div>
      </main>
    </div>
  );
}
