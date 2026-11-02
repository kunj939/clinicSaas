import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { type SessionPayload, useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { api } from '../lib/api';
import { Alert, Button, Field, Input } from '../components/ui';
import { AuthLayout } from './AuthLayout';

export function SignupPage() {
  const { t, errorText } = useI18n();
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Checks the form before the request, so the user sees which field to fix. */
  function firstProblem(): MessageKey | null {
    if (fullName.trim().length < 2) return 'auth.errName';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'auth.errEmail';
    if (password.length < 10) return 'auth.errPassword';
    return null;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = firstProblem();
    if (problem) {
      setError(t(problem));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = await api.post<SessionPayload>('/api/auth/signup', { fullName, email, password });
      setSession(payload);
      navigate('/onboarding', { replace: true });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t('auth.signupTitle')} subtitle={t('auth.signupHint')}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field id="fullName" label={t('auth.fullName')}>
          <Input id="fullName" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} />
        </Field>
        <Field id="email" label={t('auth.email')}>
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field id="password" label={t('auth.password')} hint={t('auth.passwordHint')}>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={10}
          />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t('common.saving') : t('auth.signupCta')}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        {t('auth.haveAccount')}{' '}
        <Link to="/login" className="font-medium text-teal-800 underline underline-offset-4">
          {t('nav.login')}
        </Link>
      </p>
    </AuthLayout>
  );
}
