import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider, homePathFor } from '../auth/AuthContext';
import { I18nProvider } from '../i18n';
import { en } from '../i18n/en';
import { hi } from '../i18n/hi';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answers each request by URL so pages that load several resources get realistic data. */
function routeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace(/\?.*$/, '');
    const route = routes[url] ?? { status: 404, body: { error: 'not_found', message: 'Not found' } };
    return jsonResponse(route.status, route.body);
  });
}

function renderAt(path: string) {
  return render(
    <I18nProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

describe('translations', () => {
  it('has a Hindi string for every English key', () => {
    expect(Object.keys(hi).sort()).toEqual(Object.keys(en).sort());
    for (const value of Object.values(hi)) expect(typeof value).toBe('string');
  });
});

describe('routing and sessions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthorized', message: 'Please sign in' })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends visitors without a session from a clinic page to log in', async () => {
    renderAt('/app/owner');
    expect(await screen.findByRole('heading', { name: 'Log in to your clinic' })).toBeInTheDocument();
  });

  it('renders the interface in Hindi when Hindi was chosen before', async () => {
    localStorage.setItem('clinic.lang', 'hi');
    renderAt('/login');
    expect(await screen.findByRole('heading', { name: hi['auth.loginTitle'] })).toBeInTheDocument();
  });

  it('shows a plain-language message for a wrong password, not the raw API code', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/api/auth/me': { status: 401, body: { error: 'unauthorized', message: 'Please sign in' } },
        '/api/auth/login': { status: 401, body: { error: 'invalid_credentials', message: 'Email or password is incorrect' } },
      }),
    );
    renderAt('/login');
    await screen.findByRole('heading', { name: 'Log in to your clinic' });
    await userEvent.type(screen.getByLabelText('Email'), 'owner@clinic.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.queryByText('invalid_credentials')).not.toBeInTheDocument();
  });

  it('sends each role to its own working screen', () => {
    const base = { id: 'u', email: 'x@y.z', fullName: 'X Y', doctorId: null };
    const clinic = { id: 'c' } as never;
    expect(homePathFor({ ...base, role: 'owner' }, clinic)).toBe('/app/reception');
    expect(homePathFor({ ...base, role: 'owner' }, null)).toBe('/onboarding');
    expect(homePathFor({ ...base, role: 'receptionist' }, clinic)).toBe('/app/reception');
    expect(homePathFor({ ...base, role: 'doctor', doctorId: 'd' }, clinic)).toBe('/app/doctor');
  });

  it('keeps the signed-in user away from the login form', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/api/auth/me': {
          status: 200,
          body: {
            user: { id: 'u', email: 'r@clinic.test', fullName: 'Reception', role: 'receptionist', doctorId: null },
            clinic: { id: 'c', name: 'Sunrise', timezone: 'Asia/Kolkata', defaultLanguage: 'en', bookingCutoffTime: '20:00', monthlyMessageQuota: 300, whatsappPhoneNumberId: null, slug: 's', address: null, contactPhone: null, billingTerm: 'monthly', subscriptionEndsAt: null, enabledLanguages: ['en', 'hi'], createdAt: '2026-10-30T00:00:00Z' },
          },
        },
        '/api/doctors': { status: 200, body: [] },
        '/api/clinic/today': { status: 200, body: { date: '2026-10-30', timezone: 'Asia/Kolkata' } },
      }),
    );
    renderAt('/login');
    expect((await screen.findAllByRole('heading', { name: 'Token queue' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Log in to your clinic' })).not.toBeInTheDocument();
  });
});
