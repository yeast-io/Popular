import { loadWebConfig } from '../../config/env';
import { localizedResponseError } from '../../i18n/api-error';

export async function resourceNotificationRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { apiBaseUrl } = loadWebConfig();
  const response = await fetch(`${apiBaseUrl}/me/resource-notifications${path}`, {
    ...options,
    credentials: 'include',
  });
  if (!response.ok) throw await localizedResponseError(response, 'resourceNotifications.error');
  return response.json() as Promise<T>;
}
