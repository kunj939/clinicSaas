import { LANGUAGE_NAMES, LANGUAGES, type Lang } from '../../i18n/languages';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select, Spinner, Table, tdClass } from '../../components/ui';
import { useI18n } from '../../i18n';
import { api } from '../../lib/api';
import { useResource } from '../../lib/useResource';

export interface PatientSummary {
  id: string;
  fullName: string;
  phoneMasked: string | null;
  phone?: string;
  gender: string | null;
  ageYears: number | null;
  preferredLanguage: Lang;
}

export function PatientsPage() {
  const { t, errorText } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const patients = useResource(() => api.get<PatientSummary[]>(`/api/patients?q=${encodeURIComponent(debounced)}&limit=50`), [debounced]);
  const canWrite = user?.role !== 'doctor';

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('patients.title')}
        subtitle={t('patients.hint')}
        actions={canWrite ? <Button onClick={() => setCreating((value) => !value)}>{t('patients.add')}</Button> : null}
      />
      {notice ? <Alert tone={notice.tone} onDismiss={() => setNotice(null)} dismissLabel={t('common.dismiss')}>{notice.text}</Alert> : null}

      {creating && canWrite ? (
        <NewPatientForm
          onCreated={(id) => {
            setNotice({ tone: 'success', text: t('patients.created') });
            setCreating(false);
            navigate(`/app/patients/${id}`);
          }}
          onError={(text) => setNotice({ tone: 'error', text })}
          errorText={errorText}
        />
      ) : null}

      <Card>
        <Field id="patientQuery" label={t('common.search')}>
          <Input id="patientQuery" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('queue.patientSearch')} />
        </Field>
        <div className="mt-4">
          {patients.loading && !patients.data ? <Spinner label={t('app.loading')} /> : null}
          {patients.error ? <Alert tone="error">{errorText(patients.error)}</Alert> : null}
          {patients.data && patients.data.length === 0 ? <EmptyState>{t('patients.empty')}</EmptyState> : null}
          {patients.data && patients.data.length > 0 ? (
            <Table head={[t('common.name'), t('common.phone'), t('patients.age'), t('patients.language'), '']}>
              {patients.data.map((patient) => (
                <tr key={patient.id}>
                  <td className={`${tdClass} font-medium text-slate-900`}>{patient.fullName}</td>
                  <td className={tdClass}>{patient.phone ?? patient.phoneMasked ?? '—'}</td>
                  <td className={tdClass}>{patient.ageYears ?? '—'}</td>
                  <td className={tdClass}>{LANGUAGE_NAMES[patient.preferredLanguage]}</td>
                  <td className={tdClass}>
                    <Link to={`/app/patients/${patient.id}`} className="font-medium text-teal-800 underline underline-offset-4">
                      {t('patients.view')}
                    </Link>
                  </td>
                </tr>
              ))}
            </Table>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function NewPatientForm({
  onCreated,
  onError,
  errorText,
}: {
  onCreated: (id: string) => void;
  onError: (text: string) => void;
  errorText: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState('');
  const [age, setAge] = useState('');
  const [language, setLanguage] = useState<Lang>('en');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await api.post<PatientSummary>('/api/patients', {
        fullName,
        phone: phone || null,
        gender: gender || null,
        ageYears: age ? Number(age) : null,
        preferredLanguage: language,
      });
      onCreated(created.id);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('patients.add')}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field id="pName" label={t('queue.fullName')}>
          <Input id="pName" value={fullName} onChange={(e) => setFullName(e.target.value)} required maxLength={160} />
        </Field>
        <Field id="pPhone" label={`${t('common.phone')} (${t('common.optional')})`}>
          <Input id="pPhone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field id="pGender" label={`${t('patients.gender')} (${t('common.optional')})`}>
          <Select id="pGender" value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">{t('common.select')}</option>
            <option value="female">{t('patients.gender.female')}</option>
            <option value="male">{t('patients.gender.male')}</option>
            <option value="other">{t('patients.gender.other')}</option>
          </Select>
        </Field>
        <Field id="pAge" label={`${t('patients.age')} (${t('common.optional')})`}>
          <Input id="pAge" type="number" min={0} max={130} value={age} onChange={(e) => setAge(e.target.value)} />
        </Field>
        <Field id="pLanguage" label={t('patients.language')}>
          <Select id="pLanguage" value={language} onChange={(e) => setLanguage(e.target.value as Lang)}>
            {LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {LANGUAGE_NAMES[code]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={busy || !fullName.trim()}>
            {busy ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
