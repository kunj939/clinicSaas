import type { Lang } from '../i18n/languages';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';

export type Role = 'owner' | 'receptionist' | 'doctor';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  doctorId: string | null;
}

export interface Clinic {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  contactPhone: string | null;
  timezone: string;
  defaultLanguage: Lang;
  bookingCutoffTime: string;
  monthlyMessageQuota: number;
  whatsappPhoneNumberId: string | null;
  followUpLeadDays: number;
  bookingWindowDays: number;
  whatsappDisplayNumber: string | null;
  billingTerm: BillingTerm;
  subscriptionEndsAt: string | null;
  enabledLanguages: Lang[];
  createdAt: string;
}

/** How the clinic pays: month to month, or a six-month commitment. The platform sets it. */
export type BillingTerm = 'monthly' | 'six_months';

export interface SessionPayload {
  user: SessionUser;
  clinic: Clinic | null;
}

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthValue {
  status: Status;
  user: SessionUser | null;
  clinic: Clinic | null;
  setSession: (payload: SessionPayload) => void;
  setClinic: (clinic: Clinic) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSessionState] = useState<SessionPayload | null>(null);

  useEffect(() => {
    let active = true;
    api
      .get<SessionPayload>('/api/auth/me')
      .then((payload) => {
        if (!active) return;
        setSessionState(payload);
        setStatus('authenticated');
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (!(error instanceof ApiError) || error.status !== 401) {
          // Network or server failure: treat as signed out, but keep the reason out of the UI.
          console.warn('Could not load session');
        }
        setSessionState(null);
        setStatus('anonymous');
      });
    return () => {
      active = false;
    };
  }, []);

  const setSession = useCallback((payload: SessionPayload) => {
    setSessionState(payload);
    setStatus('authenticated');
  }, []);

  const setClinic = useCallback((clinic: Clinic) => {
    setSessionState((current) => (current ? { ...current, clinic } : current));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      setSessionState(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user: session?.user ?? null,
      clinic: session?.clinic ?? null,
      setSession,
      setClinic,
      signOut,
    }),
    [status, session, setSession, setClinic, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** Where a signed-in user should land. Owners without a clinic are sent to onboarding first. */
export function homePathFor(user: SessionUser, clinic: Clinic | null): string {
  if (user.role === 'owner') return clinic ? '/app/reception' : '/onboarding';
  if (user.role === 'receptionist') return '/app/reception';
  return '/app/doctor';
}
