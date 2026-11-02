/** Every language the app can show. Keep this list in step with the API's messaging/templates.ts. */
export const LANGUAGES = ['en', 'hi', 'mr', 'gu', 'bn', 'ta', 'te', 'kn', 'pa'] as const;

export type Lang = (typeof LANGUAGES)[number];

/** Each language written in its own script, so a speaker of it can find it in the menu. */
export const LANGUAGE_NAMES: Record<Lang, string> = {
  en: 'English',
  hi: 'हिन्दी',
  mr: 'मराठी',
  gu: 'ગુજરાતી',
  bn: 'বাংলা',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  kn: 'ಕನ್ನಡ',
  pa: 'ਪੰਜਾਬੀ',
};

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}
