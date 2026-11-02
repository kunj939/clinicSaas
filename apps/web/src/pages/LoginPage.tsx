import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { homePathFor, useAuth, type SessionPayload } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { api } from '../lib/api';
import { Alert, Button, Field, Input } from '../components/ui';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const { t, errorText } = useI18n();
  const { status, user, clinic, setSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authenticated' && user) return <Navigate to={from ?? homePathFor(user, clinic)} replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = await api.post<SessionPayload>('/api/auth/login', { email, password });
      setSession(payload);
      navigate(from ?? homePathFor(payload.user, payload.clinic), { replace: true });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t('auth.loginTitle')}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="email" label={t('auth.email')}>
          <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field id="password" label={t('auth.password')}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t('common.saving') : t('auth.loginCta')}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        {t('auth.noAccount')}{' '}
        <Link to="/signup" className="font-medium text-teal-800 underline underline-offset-4">
          {t('nav.signup')}
        </Link>
      </p>
      <p className="mt-2 text-center text-xs text-slate-500">{t('auth.staffNote')}</p>
    </AuthLayout>
  );
}
