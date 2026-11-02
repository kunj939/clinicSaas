import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, type SessionUser } from '../auth/AuthContext';
import { I18nProvider } from '../i18n';
import { OnboardingPage } from '../pages/OnboardingPage';

const owner: SessionUser = { id: 'u-owner', email: 'owner@clinic.test', fullName: 'Owner', role: 'owner', doctorId: null };

function fetchMock() {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/me')) {
      return new Response(JSON.stringify({ user: owner, clinic: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/clinic/setup')) {
      return new Response(JSON.stringify({ id: 'c1', name: 'Sharma Clinic' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'not_found', message: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
}

function renderOnboarding() {
  return render(
    <I18nProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={['/onboarding']}>
          <Routes>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/app/reception" element={<p>queue screen</p>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

describe('single-doctor setup screen', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('explains what is missing instead of posting an incomplete form', async () => {
    const fetch = fetchMock();
    vi.stubGlobal('fetch', fetch);
    renderOnboarding();
    await userEvent.click(await screen.findByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByText('Please enter the clinic name (at least 2 letters).')).toBeInTheDocument();
    expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/api/clinic/setup'))).toBe(false);
  });

  it('sends one clinic, one doctor and the ticked days with their hours', async () => {
    const fetch = fetchMock();
    vi.stubGlobal('fetch', fetch);
    renderOnboarding();
    await screen.findByRole('button', { name: 'Finish setup' });

    await userEvent.type(screen.getByLabelText('Clinic name'), 'Sharma Clinic');
    await userEvent.type(screen.getByLabelText(/Doctor/), 'Dr. Sharma');
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));

    await waitFor(() => expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/api/clinic/setup'))).toBe(true));
    const call = fetch.mock.calls.find(([input]) => String(input).endsWith('/api/clinic/setup'))!;
    const body = JSON.parse(String((call[1] as RequestInit).body));

    expect(body).toMatchObject({ clinicName: 'Sharma Clinic', doctorName: 'Dr. Sharma', bookingCutoffTime: '20:00' });
    // Monday to Saturday are on by default, Sunday is off.
    expect(body.days.map((day: { weekday: number }) => day.weekday)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(body.days[0]).toEqual({ weekday: 1, startTime: '10:00', endTime: '14:00', maxTokens: 25, isActive: true });
    expect(await screen.findByText('queue screen')).toBeInTheDocument();
  });
});
