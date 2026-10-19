import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enUS from './locales/en-US';
import zhCN from './locales/zh-CN';
import { formatDuration, initializeI18n, localeStorageKey, selectInitialLocale, setLocale, translate, useI18n } from './index';

describe('i18n', () => {
  beforeEach(() => setLocale('zh-CN'));
  afterEach(() => vi.unstubAllGlobals());

  it('keeps every locale on the same translation template', () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
  });

  it('selects a saved locale before a supported browser locale', () => {
    expect(selectInitialLocale('en-US', ['zh-CN'])).toBe('en-US');
    expect(selectInitialLocale(null, ['fr-FR', 'en-AU'])).toBe('en-US');
    expect(selectInitialLocale(null, ['fr-FR'])).toBe('zh-CN');
  });

  it('interpolates translated content', () => {
    expect(translate('zh-CN', 'format.duration.minutes', { minutes: 42 })).toBe('42 分钟');
    expect(translate('en-US', 'format.duration.minutes', { minutes: 42 })).toBe('42 min');
  });

  it('formats durations with the active locale', () => {
    setLocale('en-US');
    expect(formatDuration(139)).toBe('2 hr 19 min');
  });

  it('formats calendar dates with the active locale', () => {
    setLocale('en-US');
    expect(useI18n().formatDate('2026-10-12', { dateStyle: 'medium', timeZone: 'UTC' })).toBe('Oct 12, 2026');

    setLocale('zh-CN');
    expect(useI18n().formatDate('2026-10-12', { dateStyle: 'medium', timeZone: 'UTC' })).toBe('2026年10月12日');
  });

  it('persists locale changes and synchronizes the html lang attribute', () => {
    const setItem = vi.fn();
    const documentElement = { lang: '' };
    vi.stubGlobal('window', { localStorage: { setItem } });
    vi.stubGlobal('document', { documentElement });

    setLocale('en-US');

    expect(useI18n().locale.value).toBe('en-US');
    expect(setItem).toHaveBeenCalledWith(localeStorageKey, 'en-US');
    expect(documentElement.lang).toBe('en-US');
  });

  it('restores a saved locale on initialization', () => {
    const documentElement = { lang: '' };
    vi.stubGlobal('window', { localStorage: { getItem: vi.fn(() => 'en-US') } });
    vi.stubGlobal('navigator', { languages: ['zh-CN'] });
    vi.stubGlobal('document', { documentElement });

    initializeI18n();

    expect(useI18n().locale.value).toBe('en-US');
    expect(documentElement.lang).toBe('en-US');
  });
});
