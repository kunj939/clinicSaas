import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { en, type MessageKey } from './en';
import { hi } from './hi';
import { gu } from './gu';
import { kn } from './kn';
import { mr } from './mr';
import { bn } from './bn';
import { pa } from './pa';
import { ta } from './ta';
import { te } from './te';
import { LANGUAGES, isLang, type Lang } from './languages';

export { LANGUAGES, LANGUAGE_NAMES, type Lang } from './languages';

const STORAGE_KEY = 'clinic.lang';

/**
 * English is complete. Hindi is complete. The other languages cover the core screens; any key they do
 * not translate yet shows in English, so no screen is ever blank.
 */
const dictionaries: Record<Lang, Partial<Record<MessageKey, string>>> = { en, hi, mr, gu, bn, ta, te, kn, pa };

function initialLang(): Lang {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  if (isLang(saved)) return saved;
  const browser = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en';
  return LANGUAGES.find((code) => code !== 'en' && browser.startsWith(code)) ?? 'en';
}

type Vars = Record<string, string | number>;

export interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Vars) => string;
  /** Turns any thrown value into a message the patient or staff member can understand. */
  errorText: (error: unknown) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
    localStorage.setItem(STORAGE_KEY, lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => setLangState(next), []);

  const value = useMemo<I18nValue>(() => {
    const dictionary = dictionaries[lang];
    const lookup = (key: MessageKey) => dictionary[key] ?? en[key];
    const t = (key: MessageKey, vars?: Vars) => interpolate(lookup(key), vars);
    const errorText = (error: unknown) => {
      if (error instanceof ApiError) {
        const key = `errors.${error.code}` as MessageKey;
        if (key in en) return lookup(key);
        if (error.status >= 500) return lookup('errors.internal_error');
        if (error.issues.length > 0) return lookup('errors.validation_failed');
      }
      return lookup('errors.generic');
    };
    return { lang, setLang, t, errorText };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
