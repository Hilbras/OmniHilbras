import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * The dashboard's message catalogue.
 *
 * Two languages ship: English and Arabic. Arabic is not a decoration — it is right-to-left, which is
 * what proves the layout uses logical properties rather than hard-coded `left`/`right`. A missing key
 * falls back to English and is counted, so a half-translated page is visible rather than blank.
 */

export type Locale = 'en' | 'ar';

const en = {
  'nav.dashboard': 'Dashboard',
  'nav.providers': 'Providers',
  'nav.models': 'Models',
  'nav.keys': 'API keys',
  'nav.usage': 'Usage',
  'nav.settings': 'Settings',
  'palette.search': 'Search pages and destinations',
  'palette.empty': 'No destination matches',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.loading': 'Loading',
  'keys.budget': 'Dollar budget',
  'keys.tokensPerMinute': 'Tokens per minute',
  'usage.spent': 'Spent',
  'usage.remaining': 'Remaining',
} as const;

export type MessageKey = keyof typeof en;

const ar: Partial<Record<MessageKey, string>> = {
  'nav.dashboard': 'لوحة التحكم',
  'nav.providers': 'المزودون',
  'nav.models': 'النماذج',
  'nav.keys': 'مفاتيح API',
  'nav.usage': 'الاستخدام',
  'nav.settings': 'الإعدادات',
  'palette.search': 'ابحث في الصفحات والوجهات',
  'palette.empty': 'لا توجد وجهة مطابقة',
  'common.save': 'حفظ',
  'common.cancel': 'إلغاء',
  'common.loading': 'جارٍ التحميل',
  'keys.budget': 'ميزانية بالدولار',
  'keys.tokensPerMinute': 'الرموز في الدقيقة',
  'usage.spent': 'المصروف',
  'usage.remaining': 'المتبقي',
};

export const catalogues: Record<Locale, Partial<Record<MessageKey, string>>> = { en, ar };

/** Missing keys, for the test that keeps the catalogues honest. */
export function missingKeys(locale: Locale): MessageKey[] {
  const catalogue = catalogues[locale];
  return (Object.keys(en) as MessageKey[]).filter((key) => catalogue[key] === undefined);
}

export function translate(locale: Locale, key: MessageKey, values?: Readonly<Record<string, string | number>>): string {
  const template = catalogues[locale][key] ?? en[key];
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? `{${name}}`));
}

type I18nValue = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string; direction: 'ltr' | 'rtl' };

const I18nContext = createContext<I18nValue>({ locale: 'en', setLocale: () => undefined, t: (key) => en[key], direction: 'ltr' });

export function I18nProvider({ locale, onChange, children }: { locale: Locale; onChange: (locale: Locale) => void; children: ReactNode }) {
  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale: onChange,
    t: (key, values) => translate(locale, key, values),
    direction: locale === 'ar' ? 'rtl' : 'ltr',
  }), [locale, onChange]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
