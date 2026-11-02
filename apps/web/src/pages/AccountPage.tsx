import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { useI18n } from '../i18n';
import { api } from '../lib/api';

export function AccountPage() {
  const { t, errorText } = useI18n();
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.post('/api/auth/change-password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setMessage({ tone: 'success', text: t('auth.passwordChanged') });
    } catch (reason) {
      setMessage({ tone: 'error', text: errorText(reason) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <Card title={user?.fullName}>
        <p className="text-sm text-slate-600">{user?.email}</p>
      </Card>
      <Card title={t('auth.changePassword')}>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
          <Field id="currentPassword" label={t('auth.currentPassword')}>
            <Input id="currentPassword" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          </Field>
          <Field id="newPassword" label={t('auth.newPassword')} hint={t('auth.passwordHint')}>
            <Input id="newPassword" type="password" autoComplete="new-password" minLength={10} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
