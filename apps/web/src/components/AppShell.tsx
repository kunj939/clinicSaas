import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth, type Role } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/en';
import { LanguageToggle } from '../pages/LanguageToggle';
import { BrandMark, cn } from './ui';
import { Icon, type IconName } from './icons';

type Group = 'clinic' | 'patients' | 'messages' | 'admin';

interface NavItem {
  to: string;
  label: MessageKey;
  icon: IconName;
  roles: Role[];
  group: Group;
}

const GROUP_ORDER: Group[] = ['clinic', 'patients', 'messages', 'admin'];
const GROUP_LABEL: Record<Group, MessageKey> = {
  clinic: 'nav.groupClinic',
  patients: 'nav.groupPatients',
  messages: 'nav.groupMessages',
  admin: 'nav.groupAdmin',
};

/**
 * Menu for a single-doctor clinic, grouped the way the work happens. Setup screens (doctors,
 * holidays, staff, audit log) live under Settings, so the sidebar stays short.
 */
const NAV: NavItem[] = [
  { to: '/app/reception', label: 'nav.today', icon: 'queue', roles: ['owner', 'receptionist'], group: 'clinic' },
  { to: '/app/doctor', label: 'nav.consult', icon: 'pulse', roles: ['owner'], group: 'clinic' },
  { to: '/app/doctor', label: 'nav.myQueue', icon: 'pulse', roles: ['doctor'], group: 'clinic' },
  { to: '/app/patients', label: 'nav.patients', icon: 'users', roles: ['owner', 'receptionist', 'doctor'], group: 'patients' },
  { to: '/app/diary', label: 'nav.diary', icon: 'book', roles: ['owner', 'receptionist', 'doctor'], group: 'patients' },
  { to: '/app/followups', label: 'nav.followups', icon: 'calendar', roles: ['owner', 'receptionist', 'doctor'], group: 'patients' },
  { to: '/app/messages', label: 'nav.messages', icon: 'chat', roles: ['owner', 'receptionist'], group: 'messages' },
  { to: '/app/owner/settings', label: 'nav.settings', icon: 'settings', roles: ['owner'], group: 'admin' },
];

export function AppShell() {
  const { t } = useI18n();
  const { user, clinic, signOut } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const items = NAV.filter((item) => user && item.roles.includes(user.role));
  const initials = (user?.fullName ?? '')
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOut();
      navigate('/login', { replace: true });
    } finally {
      setBusy(false);
    }
  }

  const languageButton = <LanguageToggle />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        <Link to="/" className="flex h-16 items-center gap-3 border-b border-slate-100 px-5">
          <BrandMark />
          <span className="min-w-0 truncate text-sm font-semibold leading-tight">{clinic?.name ?? t('app.name')}</span>
        </Link>

        {clinic ? (
          <nav aria-label={t('nav.menu')} className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
            {GROUP_ORDER.map((group) => {
              const groupItems = items.filter((item) => item.group === group);
              if (groupItems.length === 0) return null;
              return (
                <div key={group}>
                  <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{t(GROUP_LABEL[group])}</p>
                  <ul className="space-y-1">
                    {groupItems.map((item) => (
                      <li key={`${item.to}-${item.label}`}>
                        <NavLink
                          to={item.to}
                          className={({ isActive }) =>
                            cn(
                              'flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors',
                              isActive ? 'bg-teal-50 text-teal-900' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                            )
                          }
                        >
                          {({ isActive }) => (
                            <>
                              <span className={cn('shrink-0', isActive ? 'text-teal-700' : 'text-slate-400')}>
                                <Icon name={item.icon} />
                              </span>
                              {t(item.label)}
                            </>
                          )}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
        ) : (
          <div className="flex-1" />
        )}

        <div className="space-y-3 border-t border-slate-100 p-4">
          {clinic ? (
            <div className="flex items-center justify-between rounded-xl bg-gradient-to-r from-teal-600 to-teal-800 px-3 py-2 text-xs font-semibold text-white">
              <span>{clinic.billingTerm === 'six_months' ? t('plan.badgeSixMonths') : t('plan.badgeMonthly')}</span>
              <span className="font-medium opacity-80">{t('plan.title')}</span>
            </div>
          ) : null}
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-slate-900 text-xs font-semibold text-white" aria-hidden="true">
              {initials || '?'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user?.fullName}</p>
              <p className="truncate text-xs text-slate-500">{user?.email}</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <NavLink to="/app/account" className="text-sm font-medium text-slate-600 hover:text-slate-900">
              {t('auth.changePassword')}
            </NavLink>
            {languageButton}
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={busy}
            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-medium text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50 disabled:text-slate-400"
          >
            <Icon name="logout" className="size-4" />
            {t('nav.logout')}
          </button>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col lg:pl-64">
        {/* Mobile and tablet top bar */}
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <Link to="/" className="flex min-w-0 items-center gap-2.5">
              <BrandMark className="size-8 rounded-lg" />
              <span className="truncate text-sm font-semibold">{clinic?.name ?? t('app.name')}</span>
            </Link>
            <div className="flex shrink-0 items-center gap-2">
              {languageButton}
              <button
                type="button"
                onClick={handleSignOut}
                disabled={busy}
                aria-label={t('nav.logout')}
                className="grid min-h-10 min-w-10 place-items-center rounded-lg text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50"
              >
                <Icon name="logout" className="size-4" />
              </button>
            </div>
          </div>
          {clinic && items.length > 0 ? (
            <nav aria-label={t('nav.menu')} className="border-t border-slate-100">
              <ul className="flex gap-2 overflow-x-auto px-4 py-2">
                {items.map((item) => (
                  <li key={`${item.to}-${item.label}`} className="shrink-0">
                    <NavLink
                      to={item.to}
                      className={({ isActive }) =>
                        cn(
                          'inline-flex min-h-10 items-center gap-2 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
                          isActive ? 'bg-teal-700 text-white shadow-sm' : 'text-slate-700 hover:bg-slate-100',
                        )
                      }
                    >
                      <Icon name={item.icon} className="size-4" />
                      {t(item.label)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
