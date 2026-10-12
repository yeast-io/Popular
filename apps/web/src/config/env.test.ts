import { describe, expect, it } from 'vitest';
import { loadWebConfig } from './env';

describe('web environment', () => {
  it('normalizes the API base URL', () => {
    const config = loadWebConfig({ VITE_API_BASE_URL: '/api/v1/' } as ImportMetaEnv);
    expect(config.apiBaseUrl).toBe('/api/v1');
  });

  it('rejects a malformed API base URL', () => {
    expect(() => loadWebConfig({ VITE_API_BASE_URL: 'api/v1' } as ImportMetaEnv)).toThrow();
  });
});
