import { Link } from 'react-router-dom';
import { useAuth, homePathFor } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { LanguageToggle } from './LanguageToggle';
import { Badge, BrandMark, Button } from '../components/ui';
import { Icon, IconBadge, type IconName } from '../components/icons';
import { statusTone } from './shared/status';

/** Each feature: an icon, a short title and the longer sentence that explains it. */
const FEATURES: { icon: IconName; title: MessageKey; text: MessageKey }[] = [
  { icon: 'queue', title: 'landing.featureTitle1', text: 'landing.featureTokens' },
  { icon: 'users', title: 'landing.featureTitle2', text: 'landing.featureClinics' },
  { icon: 'chat', title: 'landing.featureTitle3', text: 'landing.featureCost' },
  { icon: 'shield', title: 'landing.featureTitle4', text: 'landing.featurePrivacy' },
  { icon: 'globe', title: 'landing.featureTitle5', text: 'landing.featureLanguage' },
  { icon: 'book', title: 'landing.featureTitle6', text: 'landing.featureAudit' },
];

const STEPS: { icon: IconName; title: MessageKey; text: MessageKey }[] = [
  { icon: 'chat', title: 'landing.step1Title', text: 'landing.step1Text' },
  { icon: 'queue', title: 'landing.step2Title', text: 'landing.step2Text' },
  { icon: 'pulse', title: 'landing.step3Title', text: 'landing.step3Text' },
];

const POINTS = ['heroPoint1', 'heroPoint2', 'heroPoint3'] as const;

/** Everything every clinic gets, whichever billing term it chooses. */
const INCLUDED: MessageKey[] = ['plan.includeLanguages', 'plan.includeDoctors', 'plan.includeBooking', 'plan.includePayments', 'plan.includeReminders'];

/** Made-up rows that show what the reception screen looks like. */
const PREVIEW_ROWS = [
  { token: 14, name: 'Meena I.', status: 'in_consultation', via: 'whatsapp' },
  { token: 15, name: 'Ravi K.', status: 'checked_in', via: 'walk_in' },
  { token: 16, name: 'Asha V.', status: 'checked_in', via: 'whatsapp' },
  { token: 17, name: 'Imran S.', status: 'booked', via: 'whatsapp' },
] as const;

const STATUS_KEY = {
  booked: 'status.booked',
  checked_in: 'status.checked_in',
  in_consultation: 'status.in_consultation',
} as const satisfies Record<string, MessageKey>;

export function LandingPage() {
  const { t } = useI18n();
  const { user, clinic } = useAuth();

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="sticky top-0 z-20 border-b border-slate-200/70 bg-white/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 font-semibold">
            <BrandMark />
            <span className="text-base">{t('app.name')}</span>
          </Link>
          <nav aria-label={t('nav.menu')} className="hidden items-center gap-7 text-sm font-medium text-slate-600 md:flex">
            <a href="#how" className="transition-colors hover:text-slate-900">
              {t('landing.navHow')}
            </a>
            <a href="#features" className="transition-colors hover:text-slate-900">
              {t('landing.navFeatures')}
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            {user ? (
              <Link to={homePathFor(user, clinic)}>
                <Button size="sm">{t('nav.overview')}</Button>
              </Link>
            ) : (
              <>
                <Link to="/login" className="hidden min-h-10 items-center rounded-xl px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 sm:inline-flex">
                  {t('nav.login')}
                </Link>
                <Link to="/signup" className="hidden sm:block">
                  <Button size="sm">{t('nav.signup')}</Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero: light background with a soft teal glow; the product preview sits beside the message. */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 -top-40 h-[40rem] bg-gradient-to-b from-teal-50 via-white to-white" aria-hidden="true" />
        <div className="pointer-events-none absolute -right-40 top-10 size-[36rem] rounded-full bg-teal-200/30 blur-3xl" aria-hidden="true" />
        <div className="relative mx-auto grid max-w-6xl grid-cols-1 gap-14 px-4 pb-20 pt-14 sm:px-6 sm:pt-20 lg:grid-cols-[1fr_1.05fr] lg:items-center">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-sm font-medium text-teal-800 shadow-sm ring-1 ring-teal-100">
              <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
              {t('landing.kicker')}
            </p>
            <h1 className="mt-6 text-4xl font-semibold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl lg:text-6xl">{t('landing.heroTitle')}</h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-slate-600 sm:text-lg">{t('landing.heroSubtitle')}</p>
            <ul className="mt-8 space-y-3">
              {POINTS.map((key) => (
                <li key={key} className="flex items-start gap-3 text-sm text-slate-700 sm:text-base">
                  <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-teal-600 text-white" aria-hidden="true">
                    <Icon name="check" className="size-3.5" />
                  </span>
                  {t(`landing.${key}` as 'landing.heroPoint1')}
                </li>
              ))}
            </ul>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Link to="/signup">
                <Button size="md" className="w-full px-6 sm:w-auto">
                  {t('landing.ctaStart')}
                </Button>
              </Link>
              <Link to="/login">
                <Button variant="secondary" className="w-full px-6 sm:w-auto">
                  {t('landing.ctaLogin')}
                </Button>
              </Link>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-500">
              {(['trust1', 'trust2', 'trust3'] as const).map((key) => (
                <li key={key} className="flex items-center gap-2">
                  <Icon name={key === 'trust1' ? 'chat' : key === 'trust2' ? 'globe' : 'shield'} className="size-4 text-teal-600" />
                  {t(`landing.${key}` as 'landing.trust1')}
                </li>
              ))}
            </ul>
          </div>

          <figure className="relative mx-auto w-full max-w-lg">
            {/* Browser frame around the reception screen */}
            <div className="overflow-hidden rounded-2xl bg-white shadow-2xl shadow-teal-900/10 ring-1 ring-slate-900/10">
              <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
                <span className="size-2.5 rounded-full bg-red-300" aria-hidden="true" />
                <span className="size-2.5 rounded-full bg-amber-300" aria-hidden="true" />
                <span className="size-2.5 rounded-full bg-emerald-300" aria-hidden="true" />
                <span className="ml-3 truncate rounded-md bg-white px-3 py-1 text-xs text-slate-500 ring-1 ring-slate-200">clinic-queue.app/reception</span>
              </div>
              <div className="p-5 sm:p-6">
                <div className="mb-4 flex items-center justify-between">
                  <p className="font-semibold text-slate-900">{t('landing.previewTitle')}</p>
                  <span className="flex items-center gap-1.5 text-xs text-slate-500">
                    <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
                    {t('queue.autoRefresh')}
                  </span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {PREVIEW_ROWS.map((row) => (
                    <li key={row.token} className="flex items-center gap-3 py-3">
                      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-900 text-sm font-semibold text-white">{row.token}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">{row.name}</p>
                        <p className="text-xs text-slate-500">{t(row.via === 'whatsapp' ? 'landing.previewWhatsapp' : 'landing.previewWalkIn')}</p>
                      </div>
                      <Badge tone={statusTone(row.status)}>{t(STATUS_KEY[row.status])}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Floating activity chips: what happens while the clinic works */}
            <div className="absolute -right-6 -top-5 hidden items-center gap-3 rounded-xl bg-white px-4 py-3 shadow-xl ring-1 ring-slate-900/5 lg:flex">
              <span className="grid size-8 place-items-center rounded-lg bg-emerald-50 text-emerald-700" aria-hidden="true">
                <Icon name="chat" className="size-4" />
              </span>
              <p className="text-xs font-medium text-slate-700">{t('landing.chipBooking')}</p>
            </div>
            <div className="absolute -bottom-8 -right-6 hidden items-center gap-3 rounded-xl bg-white px-4 py-3 shadow-xl ring-1 ring-slate-900/5 lg:flex">
              <span className="grid size-8 place-items-center rounded-lg bg-teal-50 text-teal-700" aria-hidden="true">
                <Icon name="rupee" className="size-4" />
              </span>
              <p className="text-xs font-medium text-slate-700">{t('landing.chipPaid')}</p>
            </div>
            <figcaption className="mt-14 text-center text-xs text-slate-500">{t('landing.previewCaption')}</figcaption>
          </figure>
        </div>
      </section>

      <section id="how" className="scroll-mt-20 border-t border-slate-100 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <p className="text-sm font-semibold uppercase tracking-wider text-teal-700">{t('landing.navHow')}</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{t('landing.howTitle')}</h2>
          <ol className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={index} className="relative rounded-2xl bg-white p-7 shadow-sm ring-1 ring-slate-900/5">
                <div className="flex items-center justify-between">
                  <IconBadge name={step.icon} />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t('landing.stepNumber', { n: index + 1 })}</span>
                </div>
                <h3 className="mt-6 text-lg font-semibold text-slate-900">{t(step.title)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{t(step.text)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="features" className="scroll-mt-20 bg-slate-50 py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="text-sm font-semibold uppercase tracking-wider text-teal-700">{t('landing.navFeatures')}</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{t('landing.featuresTitle')}</h2>
          <ul className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-900/5 transition-shadow hover:shadow-md">
                <IconBadge name={feature.icon} />
                <h3 className="mt-5 text-base font-semibold text-slate-900">{t(feature.title)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{t(feature.text)}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="plans" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold uppercase tracking-wider text-teal-700">{t('landing.navPlans')}</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{t('landing.plansTitle')}</h2>
          <p className="mt-4 text-base leading-relaxed text-slate-600">{t('landing.plansHint')}</p>
        </div>
        <div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
          <div className="flex flex-col rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-900/5">
            <h3 className="text-lg font-semibold text-slate-900">{t('plan.monthly')}</h3>
            <p className="mt-3 flex-1 text-sm leading-relaxed text-slate-600">{t('plan.monthlyHint')}</p>
            <Link to="/signup" className="mt-8">
              <Button variant="secondary" className="w-full">
                {t('landing.ctaStart')}
              </Button>
            </Link>
          </div>
          <div className="relative flex flex-col overflow-hidden rounded-3xl bg-gradient-to-br from-teal-700 via-teal-800 to-slate-900 p-8 text-white shadow-xl shadow-teal-900/20">
            <div className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-teal-400/20 blur-3xl" aria-hidden="true" />
            <span className="absolute right-6 top-6 rounded-full bg-amber-300/20 px-3 py-1 text-xs font-semibold text-amber-200 ring-1 ring-inset ring-amber-300/40">
              {t('landing.mostPopular')}
            </span>
            <h3 className="relative text-lg font-semibold">{t('plan.sixMonths')}</h3>
            <p className="relative mt-3 flex-1 text-sm leading-relaxed text-teal-50">{t('plan.sixMonthsHint')}</p>
            <Link to="/signup" className="relative mt-8">
              <Button variant="light" className="w-full">
                {t('landing.ctaStart')}
              </Button>
            </Link>
          </div>
        </div>
        <div className="mx-auto mt-10 max-w-4xl rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-900/5">
          <h3 className="text-base font-semibold text-slate-900">{t('plan.includedTitle')}</h3>
          <ul className="mt-6 grid gap-3.5 sm:grid-cols-2">
            {INCLUDED.map((key) => (
              <li key={key} className="flex items-center gap-3 text-sm text-slate-700">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-teal-600 text-white" aria-hidden="true">
                  <Icon name="check" className="size-3.5" />
                </span>
                {t(key)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-teal-700 via-teal-800 to-slate-900 p-8 text-white shadow-xl sm:p-12">
          <div className="pointer-events-none absolute -right-20 -top-20 size-72 rounded-full bg-teal-400/20 blur-3xl" aria-hidden="true" />
          <div className="relative flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('landing.ctaBandTitle')}</h2>
              <p className="mt-3 max-w-xl text-teal-50">{t('landing.ctaBandText')}</p>
            </div>
            <Link to="/signup" className="shrink-0">
              <Button variant="light" className="w-full px-6 sm:w-auto">
                {t('landing.ctaStart')}
              </Button>
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-2.5">
            <BrandMark className="size-7 rounded-lg" />
            <p>{t('landing.footer')}</p>
          </div>
          <div className="flex gap-5">
            <Link to="/login" className="hover:text-slate-800">
              {t('nav.login')}
            </Link>
            <Link to="/signup" className="hover:text-slate-800">
              {t('nav.signup')}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
