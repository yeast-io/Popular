import { loadWebConfig } from '../../config/env';
import { localizedResponseError } from '../../i18n/api-error';

export async function tvRequest<T>(path: string, signal: AbortSignal): Promise<T> {
  const { apiBaseUrl } = loadWebConfig();
  const response = await fetch(`${apiBaseUrl}/tv-shows${path}`, { credentials: 'include', signal });
  if (!response.ok)
    throw await localizedResponseError(response, 'tv.error.load');
  return response.json() as Promise<T>;
}
