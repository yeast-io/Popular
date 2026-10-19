import { describe, expect, it } from 'vitest';
import { apiErrorKey, localizedApiError, localizedErrorMessage } from './api-error';
import { setLocale } from './index';

describe('localized API errors', () => {
  it('maps stable API codes instead of exposing server messages', () => {
    expect(apiErrorKey({ error: { code: 'UNAUTHORIZED', message: 'server copy' } })).toBe('errors.unauthorized');
    expect(apiErrorKey({ error: { code: 'TRENDING_SYNC_IN_PROGRESS' } })).toBe('errors.trendingSyncInProgress');
  });

  it('uses the requested fallback for malformed errors', () => {
    expect(apiErrorKey(null, 'errors.loadMovies')).toBe('errors.loadMovies');
  });

  it('renders the mapped error in the active locale', () => {
    setLocale('en-US');
    expect(localizedErrorMessage(localizedApiError({ error: { code: 'NOT_FOUND' } }), 'errors.unknown')).toBe(
      'The requested content could not be found.',
    );
  });
});
