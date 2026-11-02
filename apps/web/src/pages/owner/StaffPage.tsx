import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { useResource } from '../../lib/useResource';

interface StaffMember {
  id: string;
  email: string;
  fullName: string;
  role: 'receptionist' | 'doctor';
  doctorId: string | null;
  isActive: boolean;
}

interface Doctor {
  id: string;
  name: string;
  isActive: boolean;
}

export function StaffPage() {
  const { t, errorText } = useI18n();
  const staff = useResource(() => api.get<StaffMember[]>('/api/staff'), []);
  const doctors = useResource(() => api.get<Doctor[]>('/api/doctors'), []);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<'receptionist' | 'doctor'>('receptionist');
  const [doctorId, setDoctorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setTemporaryPassword(null);
    try {
      const result = await api.post<{ temporaryPassword: string }>('/api/staff', {
        email,
        fullName,
        role,
        doctorId: role === 'doctor' ? doctorId : null,
      });
      setTemporaryPassword(result.temporaryPassword);
      setEmail('');
      setFullName('');
      setNotice({ tone: 'success', text: t('staff.created') });
      staff.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(member: StaffMember) {
    try {
      await api.patch(`/api/staff/${member.id}`, { isActive: !member.isActive });
      staff.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  }

  async function resetPassword(member: StaffMember) {
    setNotice(null);
    setTemporaryPassword(null);
    try {
      const result = await api.post<{ temporaryPassword: string }>(`/api/staff/${member.id}/reset-password`);
      setTemporaryPassword(result.temporaryPassword);
      setCopied(false);
      setNotice({ tone: 'success', text: t('staff.passwordReset') });
    } catch (error) {
      setNotice({ tone: 'error', text: errorText(error) });
    }
  }

  async function copyPassword() {
    if (!temporaryPassword) return;
    await navigator.clipboard?.writeText(temporaryPassword);
    setCopied(true);
  }

  const doctorName = (id: string | null) => doctors.data?.find((doctor) => doctor.id === id)?.name ?? '—';

  return (
    <div className="space-y-6">
      <PageHeader title={t('staff.title')} subtitle={t('staff.hint')} />
      {notice ? <Alert tone={notice.tone} onDismiss={() => setNotice(null)} dismissLabel={t('common.dismiss')}>{notice.text}</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={t('staff.title')} className="lg:col-span-2">
          {staff.loading && !staff.data ? <Spinner label={t('app.loading')} /> : null}
          {staff.data && staff.data.length === 0 ? <EmptyState>{t('staff.empty')}</EmptyState> : null}
          {staff.data && staff.data.length > 0 ? (
            <Table head={[t('common.name'), t('common.email'), t('staff.role'), t('common.status'), t('common.actions')]}>
              {staff.data.map((member) => (
                <tr key={member.id}>
                  <td className={tdClass}>{member.fullName}</td>
                  <td className={tdClass}>
                    <span className="break-all">{member.email}</span>
                  </td>
                  <td className={tdClass}>
                    {t(`staff.role.${member.role}`)}
                    {member.role === 'doctor' ? <span className="block text-xs text-slate-500">{doctorName(member.doctorId)}</span> : null}
                  </td>
                  <td className={tdClass}>
                    <Badge tone={member.isActive ? 'green' : 'slate'}>{member.isActive ? t('common.active') : t('common.inactive')}</Badge>
                  </td>
                  <td className={tdClass}>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" onClick={() => resetPassword(member)}>
                        {t('staff.resetPassword')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => toggle(member)}>
                        {member.isActive ? t('common.deactivate') : t('common.activate')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          ) : null}
        </Card>

        <Card title={t('staff.add')}>
          <form onSubmit={create} className="space-y-4" noValidate>
            <Field id="staffName" label={t('common.name')}>
              <Input id="staffName" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} />
            </Field>
            <Field id="staffEmail" label={t('common.email')}>
              <Input id="staffEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field id="staffRole" label={t('staff.role')}>
              <Select id="staffRole" value={role} onChange={(e) => setRole(e.target.value as 'receptionist' | 'doctor')}>
                <option value="receptionist">{t('staff.role.receptionist')}</option>
                <option value="doctor">{t('staff.role.doctor')}</option>
              </Select>
            </Field>
            {role === 'doctor' ? (
              <Field id="staffDoctor" label={t('staff.linkedDoctor')}>
                <Select id="staffDoctor" value={doctorId} onChange={(e) => setDoctorId(e.target.value)} required>
                  <option value="">{t('common.select')}</option>
                  {doctors.data?.filter((doctor) => doctor.isActive).map((doctor) => (
                    <option key={doctor.id} value={doctor.id}>
                      {doctor.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Button type="submit" className="w-full" disabled={busy || (role === 'doctor' && !doctorId)}>
              {busy ? t('common.adding') : t('staff.add')}
            </Button>
          </form>

          {temporaryPassword ? (
            <div className="mt-5 space-y-2 rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
              <p className="text-sm font-medium text-amber-900">{t('staff.tempPassword')}</p>
              <p className="break-all font-mono text-base text-slate-900" data-testid="temp-password">
                {temporaryPassword}
              </p>
              <p className="text-xs text-amber-900">{t('staff.tempPasswordNotice')}</p>
              <Button size="sm" variant="secondary" onClick={copyPassword}>
                {copied ? t('common.copied') : t('common.copy')}
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
