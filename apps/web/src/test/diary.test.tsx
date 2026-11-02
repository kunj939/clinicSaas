import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, type SessionUser } from '../auth/AuthContext';
import { I18nProvider } from '../i18n';
import { DiaryPage } from '../pages/shared/DiaryPage';

const owner: SessionUser = { id: 'u-owner', email: 'owner@clinic.test', fullName: 'Owner', role: 'owner', doctorId: null };

const diary = {
  date: '2026-10-30',
  entries: [
    {
      tokenId: 't1',
      tokenNumber: 1,
      status: 'completed',
      source: 'walk_in',
      doctorId: 'd1',
      doctorName: 'Dr Sharma',
      patientId: 'p1',
      patientName: 'Meena Iyer',
      phone: '+919800044444',
      diagnosis: 'Fever',
      prescription: null,
      medicineDays: 30,
      followUpDate: '2026-11-28',
      feeAmount: 500,
      amountPaid: 500,
      paymentMethod: 'upi',
    },
  ],
  summary: { patientsSeen: 1, collected: 500, due: 0, byMethod: { cash: 0, upi: 500, card: 0, other: 0 } },
};

function fetchMock() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith('/api/auth/me')
      ? { user: owner, clinic: { id: 'c1', name: 'Sharma Clinic', followUpLeadDays: 1 } }
      : url.startsWith('/api/diary')
        ? diary
        : { error: 'not_found', message: 'Not found' };
    return new Response(JSON.stringify(body), { status: url.startsWith('/api/diary') || url.startsWith('/api/auth/me') ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('daily diary', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', fetchMock());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the day summary and each patient with the medicine and payment', async () => {
    render(
      <I18nProvider>
        <AuthProvider>
          <MemoryRouter>
            <DiaryPage />
          </MemoryRouter>
        </AuthProvider>
      </I18nProvider>,
    );

    expect(await screen.findByText('Meena Iyer')).toBeInTheDocument();
    expect(screen.getByText('+919800044444')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    // UPI appears in the summary hint and on the row.
    expect(screen.getAllByText(/UPI/).length).toBeGreaterThanOrEqual(2);
  });

  it('opens the payment form for a patient', async () => {
    render(
      <I18nProvider>
        <AuthProvider>
          <MemoryRouter>
            <DiaryPage />
          </MemoryRouter>
        </AuthProvider>
      </I18nProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Edit payment' }));
    expect(screen.getByLabelText('Fee (₹)')).toHaveValue(500);
    expect(screen.getByRole('button', { name: 'Save payment' })).toBeInTheDocument();
  });
});
