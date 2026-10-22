import type { SupportedLocale } from './locale.types.js';
import { supportedLocales } from '@movie-hub/contract';

export { supportedLocales };

export const defaultLocale: SupportedLocale = 'zh-CN';
export const localeStorageKey = 'movie-hub.locale';

export function resolveSupportedLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US';
  return null;
}

export function selectInitialLocale(savedLocale: string | null, browserLocales: readonly string[]): SupportedLocale {
  return (
    resolveSupportedLocale(savedLocale)
    ?? browserLocales.map(resolveSupportedLocale).find((locale): locale is SupportedLocale => {
      return locale !== null;
    })
    ?? defaultLocale
  );
}
