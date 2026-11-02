import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { homePathFor, type Role, useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { Spinner } from './ui';

export function FullPageSpinner() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner label={t('app.loading')} />
    </div>
  );
}

/**
 * Route guard. Sends visitors to log in, enforces roles, and makes owners finish clinic setup
 * before reaching clinical pages. `clinic: false` is used for onboarding and redirects away once a clinic exists.
 */
export function Guard({ roles, clinic }: { roles?: Role[]; clinic?: boolean }) {
  const { status, user, clinic: currentClinic } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homePathFor(user, currentClinic)} replace />;
  if (clinic === true && !currentClinic) return <Navigate to="/onboarding" replace />;
  if (clinic === false && currentClinic) return <Navigate to={homePathFor(user, currentClinic)} replace />;
  return <Outlet />;
}
