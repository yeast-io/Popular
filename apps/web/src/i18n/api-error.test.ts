import { describe, expect, it } from 'vitest';
import { apiErrorKey, localizedApiError, localizedErrorMessage } from './api-error';
import { setLocale } from './index';

describe('localized API errors', () => {
  it('maps stable API codes instead of exposing server messages', () => {
    expect(apiErrorKey({ error: { code: 'UNAUTHORIZED', message: 'server copy' } })).toBe('errors.unauthorized');
    expect(apiErrorKey({ error: { code: 'MEDIA_TRENDING_EXPIRED' } })).toBe('errors.mediaTrendingExpired');
  });

  it('uses the requested fallback for malformed errors', () => {
    expect(apiErrorKey(null, 'errors.loadMovies')).toBe('errors.loadMovies');
  });

  it('renders the mapped error in the active locale', () => {
    setLocale('en-US');
    expect(localizedErrorMessage(localizedApiError({ error: { code: 'NOT_FOUND' } }), 'errors.unknown')).toBe(
      'The requested content could not be found.'
    );
  });
});

it('preserves actionable site failure reasons in both languages and ignores unknown server text', () => {
  const failure = { error: { code: 'RESOURCE_SITE_FAILED', details: { reason: 'authentication' }, message: 'raw payload' } };
  for (const locale of ['en-US', 'zh-CN'] as const) {
    setLocale(locale);
    const message = localizedErrorMessage(localizedApiError(failure), 'errors.unknown');
    expect(message).toContain('Cookie');
    expect(message).not.toContain('raw payload');
  }
  expect(apiErrorKey({ error: { code: 'RESOURCE_SITE_FAILED', details: { reason: '__proto__' } } })).toBe(
    'resourceSite.error.invalidResponse'
  );
});

it.each(['en-US', 'zh-CN'] as const)('explains site account conflicts and pending migration without exposing server details (%s)', (locale) => {
  setLocale(locale);
  for (const [code, expected] of [
    ['RESOURCE_SITE_ACCOUNT_IN_USE', locale === 'zh-CN' ? '该站点账号已绑定其他账号。' : 'This site account is already linked to another account.'],
    ['RESOURCE_SITE_IDENTITY_PENDING', locale === 'zh-CN' ? '已有站点账号尚未完成身份验证，暂时无法添加新的绑定。' : 'Existing site accounts still need identity verification. New bindings are temporarily unavailable.'],
  ]) expect(localizedErrorMessage(localizedApiError({ error: { code, message: 'private internal details' } }), 'errors.unknown')).toBe(expected);
});
