import type { TranslationKey, TranslationParams } from './translation.types.js';
import { readonly, ref } from 'vue';
import enUS from './locales/en-US';
import zhCN from './locales/zh-CN';
import { defaultLocale, localeStorageKey, selectInitialLocale, supportedLocales } from './locale';
import type { SupportedLocale } from './locale.types';

export { defaultLocale, localeStorageKey, selectInitialLocale, supportedLocales } from './locale';
export type { SupportedLocale } from './locale.types';

const messages = {
  'zh-CN': zhCN,
  'en-US': enUS,
} as const;

const activeLocale = ref<SupportedLocale>(defaultLocale);

export function initializeI18n(): void {
  const savedLocale = typeof window === 'undefined' ? null : window.localStorage.getItem(localeStorageKey);
  const browserLocales = typeof navigator === 'undefined' ? [] : navigator.languages;
  applyLocale(selectInitialLocale(savedLocale, browserLocales), false);
}

export function setLocale(locale: SupportedLocale): void {
  applyLocale(locale, true);
}

export function translate(locale: SupportedLocale, key: TranslationKey, params: TranslationParams = {}): string {
  const template = messages[locale][key] ?? messages[defaultLocale][key];
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

export function t(key: TranslationKey, params?: TranslationParams): string {
  return translate(activeLocale.value, key, params);
}

export function formatDate(
  value: Date | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(activeLocale.value, options).format(date);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(activeLocale.value, options).format(value);
}

export function formatDuration(minutes: number): string {
  const wholeMinutes = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(wholeMinutes / 60);
  const remainingMinutes = wholeMinutes % 60;
  return hours > 0
    ? t('format.duration.hoursMinutes', { hours, minutes: remainingMinutes })
    : t('format.duration.minutes', { minutes: remainingMinutes });
}

export function useI18n() {
  return {
    locale: readonly(activeLocale),
    supportedLocales,
    setLocale,
    t,
    formatDate,
    formatNumber,
    formatDuration,
  } as const;
}

function applyLocale(locale: SupportedLocale, persist: boolean): void {
  activeLocale.value = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  if (persist && typeof window !== 'undefined') window.localStorage.setItem(localeStorageKey, locale);
}
