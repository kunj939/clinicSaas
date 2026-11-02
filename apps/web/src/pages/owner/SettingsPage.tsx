import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, type Clinic } from '../../auth/AuthContext';
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Select } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/en';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { LANGUAGE_NAMES, LANGUAGES, type Lang } from '../../i18n/languages';

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Dhaka', 'Asia/Kathmandu', 'Asia/Colombo', 'UTC'];

/** Setup screens that were removed from the top menu. */
const MANAGE_LINKS: { to: string; label: MessageKey }[] = [
  { to: '/app/owner/doctors', label: 'nav.doctors' },
  { to: '/app/owner/holidays', label: 'nav.holidays' },
  { to: '/app/owner/staff', label: 'nav.staff' },
  { to: '/app/owner', label: 'nav.overview' },
  { to: '/app/owner/audit', label: 'nav.audit' },
];

export function SettingsPage() {
  const { clinic, setClinic } = useAuth();
  if (!clinic) return null;
  return <SettingsForm key={clinic.id} clinic={clinic} onSaved={setClinic} />;
}

function SettingsForm({ clinic, onSaved }: { clinic: Clinic; onSaved: (clinic: Clinic) => void }) {
  const { t, errorText } = useI18n();
  const [name, setName] = useState(clinic.name);
  const [address, setAddress] = useState(clinic.address ?? '');
  const [contactPhone, setContactPhone] = useState(clinic.contactPhone ?? '');
  const [timezone, setTimezone] = useState(clinic.timezone);
  const [defaultLanguage, setDefaultLanguage] = useState<Lang>(clinic.defaultLanguage);
  const [offered, setOffered] = useState<Lang[]>(clinic.enabledLanguages);
  const [cutoff, setCutoff] = useState(clinic.bookingCutoffTime);
  const [leadDays, setLeadDays] = useState(String(clinic.followUpLeadDays));
  const [windowDays, setWindowDays] = useState(String(clinic.bookingWindowDays));
  const [displayNumber, setDisplayNumber] = useState(clinic.whatsappDisplayNumber ?? '');
  const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = useState(clinic.whatsappPhoneNumberId ?? '');
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /** The default language is always offered, so choosing it also ticks it. */
  function chooseDefault(code: Lang) {
    setDefaultLanguage(code);
    setOffered((current) => (current.includes(code) ? current : [...current, code]));
  }

  function toggleLanguage(code: Lang) {
    if (code === defaultLanguage) return;
    setOffered((current) => (current.includes(code) ? current.filter((item) => item !== code) : [...current, code]));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const updated = await api.patch<Clinic>('/api/clinic', {
        name,
        address: address || null,
        contactPhone: contactPhone || null,
        timezone,
        defaultLanguage,
        enabledLanguages: LANGUAGES.filter((code) => offered.includes(code)),
        bookingCutoffTime: cutoff,
        whatsappPhoneNumberId: whatsappPhoneNumberId || null,
        followUpLeadDays: Number(leadDays),
        bookingWindowDays: Number(windowDays),
        whatsappDisplayNumber: displayNumber.trim() || null,
      });
      onSaved(updated);
      setNotice({ tone: 'success', text: t('settings.saved') });
    } catch (reason) {
      setNotice({ tone: 'error', text: errorText(reason) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('settings.title')} subtitle={t('settings.quotaNote')} />
      <SubscriptionCard clinic={clinic} />
      <Card title={t('settings.manage')}>
        <ul className="grid gap-2 sm:grid-cols-2">
          {MANAGE_LINKS.map((link) => (
            <li key={link.to}>
              <Link
                to={link.to}
                className="flex min-h-11 items-center justify-between rounded-lg px-4 text-base font-medium text-slate-800 ring-1 ring-inset ring-slate-200 hover:bg-teal-50"
              >
                {t(link.label)}
                <span aria-hidden="true" className="text-slate-400">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <form onSubmit={save} className="space-y-5" noValidate>
          {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="settingsName" label={t('onboarding.clinicName')}>
              <Input id="settingsName" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={160} />
            </Field>
            <Field id="settingsPhone" label={`${t('onboarding.contactPhone')} (${t('common.optional')})`}>
              <Input id="settingsPhone" type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
            </Field>
          </div>
          <Field id="settingsAddress" label={`${t('onboarding.address')} (${t('common.optional')})`}>
            <Input id="settingsAddress" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
          </Field>

          <fieldset className="space-y-3 rounded-2xl bg-slate-50/70 p-4 ring-1 ring-slate-200">
            <legend className="px-1 text-sm font-semibold text-slate-900">{t('settings.languages')}</legend>
            <p className="text-sm text-slate-600">{t('settings.languagesHint')}</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {LANGUAGES.map((code) => {
                const checked = offered.includes(code);
                return (
                  <label
                    key={code}
                    className={`flex min-h-11 items-center justify-between gap-2 rounded-xl px-3 text-sm ring-1 ring-inset transition-colors ${
                      checked ? 'bg-white ring-teal-300' : 'bg-white/60 ring-slate-200'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4 accent-teal-700"
                        checked={checked}
                        disabled={code === defaultLanguage}
                        onChange={() => toggleLanguage(code)}
                      />
                      {LANGUAGE_NAMES[code]}
                    </span>
                    {code === defaultLanguage ? <Badge tone="teal">{t('settings.default')}</Badge> : null}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="settingsTimezone" label={t('onboarding.timezone')}>
              <Select id="settingsTimezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {TIMEZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="settingsLanguage" label={t('onboarding.defaultLanguage')}>
              <Select id="settingsLanguage" value={defaultLanguage} onChange={(e) => chooseDefault(e.target.value as Lang)}>
                {LANGUAGES.map((code) => (
                  <option key={code} value={code}>
                    {LANGUAGE_NAMES[code]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="settingsCutoff" label={t('onboarding.cutoff')}>
              <Input id="settingsCutoff" type="time" value={cutoff} onChange={(e) => setCutoff(e.target.value)} required />
            </Field>
          </div>
          <Field id="settingsLeadDays" label={t('settings.leadDays')} hint={t('settings.leadDaysHint')}>
            <Input
              id="settingsLeadDays"
              type="number"
              inputMode="numeric"
              min={0}
              max={30}
              className="sm:w-40!"
              value={leadDays}
              onChange={(e) => setLeadDays(e.target.value)}
              required
            />
          </Field>
          <Field id="settingsWindow" label={t('settings.bookingWindow')} hint={t('settings.bookingWindowHint')}>
            <Select id="settingsWindow" className="sm:w-72!" value={windowDays} onChange={(e) => setWindowDays(e.target.value)}>
              {Array.from({ length: 7 }, (_, index) => index + 1).map((days) => {
                const label = days === 1 ? t('settings.tomorrowOnly') : t('doctor.daysChip', { n: days });
                return (
                  <option key={days} value={days}>
                    {label}
                  </option>
                );
              })}
            </Select>
          </Field>
          <Field id="settingsDisplayNumber" label={`${t('settings.displayNumber')} (${t('common.optional')})`} hint={t('settings.displayNumberHint')}>
            <Input
              id="settingsDisplayNumber"
              type="tel"
              placeholder="+919876543210"
              value={displayNumber}
              onChange={(e) => setDisplayNumber(e.target.value)}
            />
          </Field>
          <Field id="settingsWhatsapp" label={`${t('onboarding.whatsappNumberId')} (${t('common.optional')})`} hint={t('settings.whatsappHint')}>
            <Input id="settingsWhatsapp" inputMode="numeric" value={whatsappPhoneNumberId} onChange={(e) => setWhatsappPhoneNumberId(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </form>
      </Card>
      <BookingLinkCard number={clinic.whatsappDisplayNumber} />
    </div>
  );
}

/** One package with everything included. The card shows the clinic's billing term and when it ends. */
function SubscriptionCard({ clinic }: { clinic: Clinic }) {
  const { t, lang } = useI18n();
  const sixMonths = clinic.billingTerm === 'six_months';
  const included: MessageKey[] = ['plan.includeLanguages', 'plan.includeDoctors', 'plan.includeBooking', 'plan.includePayments', 'plan.includeReminders'];
  return (
    <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-teal-700 via-teal-800 to-slate-900 p-6 text-white shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-200">{t('plan.title')}</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">{t('plan.fullAccess')}</h2>
          <p className="mt-1 text-sm text-teal-100">{t(sixMonths ? 'plan.billingSixMonths' : 'plan.billingMonthly')}</p>
        </div>
        {clinic.subscriptionEndsAt ? (
          <span className="rounded-full bg-white/10 px-3 py-1 text-sm ring-1 ring-inset ring-white/20">
            {t('plan.endsOn', { date: formatDate(clinic.subscriptionEndsAt, lang) })}
          </span>
        ) : null}
      </div>
      <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
        {included.map((key) => (
          <li key={key} className="flex items-center gap-2.5 text-sm">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-emerald-400/20 text-emerald-200">
              <Icon name="check" className="size-3.5" />
            </span>
            {t(key)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The text the patient's WhatsApp opens with. The bot treats "book" or "token" in any message as a request to book. */
const BOOKING_MESSAGE = 'Hi, I want to book a token';

/** Click-to-chat link: opening it in WhatsApp puts the booking message in the box, ready to send. */
function BookingLinkCard({ number }: { number: string | null }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  if (!number) {
    return (
      <Card title={t('settings.bookingLink')}>
        <p className="text-sm text-slate-600">{t('settings.bookingLinkNeedsNumber')}</p>
      </Card>
    );
  }
  const link = `https://wa.me/${number.replace(/\D/g, '')}?text=${encodeURIComponent(BOOKING_MESSAGE)}`;
  return (
    <Card title={t('settings.bookingLink')}>
      <p className="mb-3 text-sm text-slate-600">{t('settings.bookingLinkHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label={t('settings.bookingLink')} readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1" />
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
    </Card>
  );
}
