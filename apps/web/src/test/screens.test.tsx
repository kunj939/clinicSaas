import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, type Clinic, type SessionUser } from '../auth/AuthContext';
import { Guard } from '../components/Guards';
import { I18nProvider } from '../i18n';
import { OwnerOverviewPage } from '../pages/owner/OwnerOverviewPage';
import { QueuePage } from '../pages/reception/QueuePage';
import { DoctorQueuePage } from '../pages/doctor/DoctorQueuePage';

const clinic: Clinic = {
  id: 'clinic-1',
  name: 'Sunrise Clinic',
  slug: 'sunrise',
  address: null,
  contactPhone: null,
  timezone: 'Asia/Kolkata',
  defaultLanguage: 'en',
  bookingCutoffTime: '20:00',
  monthlyMessageQuota: 300,
  whatsappPhoneNumberId: null,
  followUpLeadDays: 1,
  bookingWindowDays: 1,
  whatsappDisplayNumber: null,
  billingTerm: 'monthly',
  subscriptionEndsAt: null,
  enabledLanguages: ['en', 'hi'],
  createdAt: '2026-10-30T00:00:00Z',
};

const doctorUser: SessionUser = { id: 'u-doc', email: 'doc@clinic.test', fullName: 'Dr Asha', role: 'doctor', doctorId: 'doc-1' };
const receptionUser: SessionUser = { ...doctorUser, id: 'u-rec', role: 'receptionist', doctorId: null };
const ownerUser: SessionUser = { ...doctorUser, id: 'u-owner', role: 'owner', doctorId: null };

const queueResponse = {
  date: '2026-10-30',
  doctor: { id: 'doc-1', name: 'Dr Asha', isActive: true },
  capacity: 10,
  activeCount: 2,
  lastTokenNumber: 2,
  tokens: [
    { id: 't1', tokenNumber: 1, status: 'in_consultation', source: 'walk_in', patientId: 'p1', patientName: 'Meena Iyer', phoneMasked: '+91******0050', visitId: null, checkedInAt: null, calledAt: null },
    { id: 't2', tokenNumber: 2, status: 'checked_in', source: 'phone', patientId: 'p2', patientName: 'Ravi Kumar', phoneMasked: null, visitId: null, checkedInAt: null, calledAt: null },
  ],
};

/** Answers by URL so each screen gets the data it asks for; anything unexpected is a 404 the page must survive. */
function routes(map: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace(/\?.*$/, '');
    const body = map[url];
    return new Response(JSON.stringify(body ?? { error: 'not_found', message: 'Not found' }), {
      status: body === undefined ? 404 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function mount(element: ReactElement, path: string, user: SessionUser) {
  return render(
    <I18nProvider>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Guard roles={[user.role]} clinic />}>
              <Route path={path} element={element} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

describe('clinic screens render with realistic data', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('owner overview shows today\'s tokens and the setup checklist', async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/auth/me': { user: ownerUser, clinic },
        '/api/clinic/today': { date: '2026-10-30', timezone: 'Asia/Kolkata' },
        '/api/clinic/usage': { period: '2026-10', notificationsSent: 12, quota: 300 },
        '/api/queue/summary': [{ doctorId: 'doc-1', doctorName: 'Dr Asha', capacity: 10, activeCount: 2, waiting: 1, inConsultation: 1, completed: 0, noShow: 0 }],
        '/api/doctors': [{ id: 'doc-1', name: 'Dr Asha', isActive: true, workingDays: [1, 2] }],
        '/api/staff': [],
        '/api/holidays': [],
      }),
    );
    mount(<OwnerOverviewPage />, '/app/owner', ownerUser);
    expect((await screen.findAllByText('Dr Asha')).length).toBeGreaterThan(0);
    expect(await screen.findByText('Setup checklist')).toBeInTheDocument();
    expect(screen.getByText('2 / 10')).toBeInTheDocument();
  });

  it('reception queue lists tokens with masked phone numbers and the booking form', async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/auth/me': { user: receptionUser, clinic },
        '/api/clinic/today': { date: '2026-10-30', timezone: 'Asia/Kolkata' },
        '/api/doctors': [{ id: 'doc-1', name: 'Dr Asha', isActive: true }],
        '/api/queue': queueResponse,
      }),
    );
    mount(<QueuePage />, '/app/reception', receptionUser);
    expect(await screen.findByText('Meena Iyer')).toBeInTheDocument();
    expect(screen.getByText('+91******0050')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Book a token' })).toBeInTheDocument();
    // Token 2 is already checked in, so it offers the no-show and cancel actions instead of check-in.
    expect(screen.getByRole('button', { name: 'Missed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('doctor screen shows the patient being served and offers to call the next patient', async () => {
    vi.stubGlobal(
      'fetch',
      routes({
        '/api/auth/me': { user: doctorUser, clinic },
        '/api/clinic/today': { date: '2026-10-30', timezone: 'Asia/Kolkata' },
        '/api/queue': queueResponse,
        '/api/follow-ups': [],
        '/api/reports': [],
        '/api/tokens/t1/visit': null,
      }),
    );
    mount(<DoctorQueuePage />, '/app/doctor', doctorUser);
    expect((await screen.findAllByText(/Meena Iyer/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Consultation notes · #1 Meena Iyer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call next patient' })).toBeDisabled();
  });
});
