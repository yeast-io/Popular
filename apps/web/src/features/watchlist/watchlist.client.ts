import { loadWebConfig } from '../../config/env';
import { localizedResponseError } from '../../i18n/api-error';

export async function watchlistRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { apiBaseUrl } = loadWebConfig();
  const response = await fetch(`${apiBaseUrl}/me/watchlist${path}`, { ...options, credentials: 'include' });
  if (!response.ok) throw await localizedResponseError(response, 'watchlist.error');
  return response.json() as Promise<T>;
}
