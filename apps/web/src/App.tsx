import { Link, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Guard } from './components/Guards';
import { useI18n } from './i18n';
import { AccountPage } from './pages/AccountPage';
import { HomeRedirect } from './pages/HomeRedirect';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { OwnerOverviewPage } from './pages/owner/OwnerOverviewPage';
import { DoctorsPage } from './pages/owner/DoctorsPage';
import { HolidaysPage } from './pages/owner/HolidaysPage';
import { StaffPage } from './pages/owner/StaffPage';
import { SettingsPage } from './pages/owner/SettingsPage';
import { AuditPage } from './pages/owner/AuditPage';
import { QueuePage } from './pages/reception/QueuePage';
import { MessagesPage } from './pages/reception/MessagesPage';
import { PatientsPage } from './pages/shared/PatientsPage';
import { PatientDetailPage } from './pages/shared/PatientDetailPage';
import { FollowUpsPage } from './pages/shared/FollowUpsPage';
import { DiaryPage } from './pages/shared/DiaryPage';
import { DoctorQueuePage } from './pages/doctor/DoctorQueuePage';

function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-lg text-slate-700">{t('app.notFound')}</p>
      <Link to="/" className="font-medium text-teal-800 underline underline-offset-4">
        {t('app.backHome')}
      </Link>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />

      <Route element={<Guard />}>
        <Route element={<AppShell />}>
          <Route element={<Guard clinic={false} />}>
            <Route path="/onboarding" element={<OnboardingPage />} />
          </Route>

          <Route element={<Guard clinic />}>
            <Route path="/app" element={<HomeRedirect />} />
            <Route path="/app/account" element={<AccountPage />} />

            <Route element={<Guard roles={['owner']} />}>
              <Route path="/app/owner" element={<OwnerOverviewPage />} />
              <Route path="/app/owner/doctors" element={<DoctorsPage />} />
              <Route path="/app/owner/holidays" element={<HolidaysPage />} />
              <Route path="/app/owner/staff" element={<StaffPage />} />
              <Route path="/app/owner/settings" element={<SettingsPage />} />
              <Route path="/app/owner/audit" element={<AuditPage />} />
            </Route>

            <Route element={<Guard roles={['owner', 'receptionist']} />}>
              <Route path="/app/reception" element={<QueuePage />} />
              <Route path="/app/messages" element={<MessagesPage />} />
            </Route>

            <Route element={<Guard roles={['owner', 'receptionist', 'doctor']} />}>
              <Route path="/app/patients" element={<PatientsPage />} />
              <Route path="/app/patients/:id" element={<PatientDetailPage />} />
              <Route path="/app/followups" element={<FollowUpsPage />} />
              <Route path="/app/diary" element={<DiaryPage />} />
            </Route>

            <Route element={<Guard roles={['owner', 'doctor']} />}>
              <Route path="/app/doctor" element={<DoctorQueuePage />} />
            </Route>
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
