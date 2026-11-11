import type { AgentResourceModeResponse, RemoteClientConfiguration, Locale } from '@movie-hub/contract';
import { localizedResponseError } from '../../i18n/api-error';

export function createAgentResourceClient(apiBaseUrl: string, locale: () => Locale) {
  async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      credentials: 'include',
      cache: 'no-store',
      signal,
      method: body === undefined ? 'GET' : 'PUT',
      headers: { 'accept-language': locale(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await localizedResponseError(response);
    return response.json() as Promise<T>;
  }
  return {
    mode: (signal: AbortSignal) => request<AgentResourceModeResponse>('/me/resource-execution', signal),
    devices: (signal: AbortSignal) => request<RemoteClientConfiguration>('/me/remote-client', signal),
    save: (deviceId: string | null, signal: AbortSignal) =>
      request<AgentResourceModeResponse>('/me/resource-execution', signal, { deviceId }),
  };
}
