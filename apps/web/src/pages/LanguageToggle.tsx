import { useAuth } from '../auth/AuthContext';
import { LANGUAGE_NAMES, LANGUAGES, useI18n, type Lang } from '../i18n';

/**
 * Language menu. Inside a clinic it lists only the languages the clinic chose to offer; on the public
 * pages it lists all of them. Each language is shown in its own script. The choice is remembered on this device.
 */
export function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  const { clinic } = useAuth();
  const offered: readonly Lang[] = clinic ? clinic.enabledLanguages : LANGUAGES;
  // If the current language is not offered (the clinic changed its choice), keep it visible so the menu is never blank.
  const options = offered.includes(lang) ? offered : [lang, ...offered];
  return (
    <select
      aria-label={t('nav.language')}
      value={lang}
      onChange={(event) => setLang(event.target.value as Lang)}
      className="min-h-10 max-w-40 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20"
    >
      {options.map((code) => (
        <option key={code} value={code}>
          {LANGUAGE_NAMES[code]}
        </option>
      ))}
    </select>
  );
}
