import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider } from '../auth/AuthContext';
import { I18nProvider, LANGUAGES, useI18n } from '../i18n';
import { LanguageToggle } from '../pages/LanguageToggle';

function Probe() {
  const { t } = useI18n();
  return (
    <>
      <LanguageToggle />
      <p>{t('nav.today')}</p>
      <p>{t('nav.overview')}</p>
    </>
  );
}

describe('languages', () => {
  beforeEach(() => {
    localStorage.clear();
    // Signed out: the language menu then offers every language.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized', message: 'Please sign in' }), { status: 401, headers: { 'Content-Type': 'application/json' } })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers every language, each in its own script', () => {
    render(
      <I18nProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </I18nProvider>,
    );
    const menu = screen.getByRole('combobox', { name: 'Language' });
    expect(LANGUAGES).toHaveLength(9);
    expect(screen.getByRole('option', { name: 'मराठी' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'தமிழ்' })).toBeInTheDocument();
    expect(menu).toHaveValue('en');
  });

  it('switches the core screens to the chosen language and falls back to English for keys not yet translated', async () => {
    render(
      <I18nProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </I18nProvider>,
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'mr');
    expect(screen.getByText('आज')).toBeInTheDocument();
    // "Overview" has no Marathi translation yet, so it stays in English instead of going blank.
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(localStorage.getItem('clinic.lang')).toBe('mr');
  });

  it('inside a clinic, offers only the languages the clinic chose', async () => {
    const clinic = { id: 'c', name: 'Sunrise', slug: 's', address: null, contactPhone: null, timezone: 'Asia/Kolkata', defaultLanguage: 'en', enabledLanguages: ['en', 'mr'], bookingCutoffTime: '20:00', monthlyMessageQuota: 300, whatsappPhoneNumberId: null, whatsappDisplayNumber: null, followUpLeadDays: 1, bookingWindowDays: 1, plan: 'starter', planLimits: { maxLanguages: 2, maxDoctors: 1, bookingWindowMax: 1, onlinePayments: false, autoReminders: false }, createdAt: '2026-10-30T00:00:00Z' };
    const user = { id: 'u', email: 'o@clinic.test', fullName: 'Owner', role: 'owner', doctorId: null };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user, clinic }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render(
      <I18nProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </I18nProvider>,
    );
    // The menu first shows every language, then narrows to the clinic's choice once the session loads.
    await waitFor(() => expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['English', 'मराठी']));
  });
});
