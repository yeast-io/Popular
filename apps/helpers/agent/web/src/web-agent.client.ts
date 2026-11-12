import type { AgentClient } from '@movie-hub/helper-agent-ui/transport';
import type { ManagementSession, WebAgentClient, WebAgentOptions } from './web-agent.types';

export function createWebAgentClient(options: WebAgentOptions): WebAgentClient {
  let csrf = '';
  let active = true;
  let revision = 0;
  const streams = new Set<EventSource>();
  function expire() {
    if (!active || !csrf) return;
    csrf = '';
    revision++;
    streams.forEach((stream) => stream.close());
    streams.clear();
    options.onSessionExpired();
  }
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!active) throw 'managementSessionExpired';
    const current = revision;
    const write = method !== 'GET';
    const headers: Record<string, string> = {};
    // randomUUID is absent on ordinary HTTP LAN origins; the server assigns the ID.
    if (typeof globalThis.crypto?.randomUUID === 'function') headers['x-request-id'] = crypto.randomUUID();
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (write && path !== '/session') {
      if (!csrf) throw 'managementSessionExpired';
      headers['x-csrf-token'] = csrf;
    }
    if (method === 'DELETE' && csrf) headers['x-csrf-token'] = csrf;
    let response: Response;
    try {
      response = await fetch(`/api${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw 'networkError';
    }
    if (current === revision && response.status === 401 && !(method === 'POST' && path === '/session')) expire();
    const value = await response.json().catch(() => {
      throw 'invalidResponse';
    });
    if (!response.ok) throw typeof value?.error?.code === 'string' ? value.error.code : 'unknownError';
    return value as T;
  }
  function receiveSession(value: ManagementSession, current: number) {
    if (active && current === revision) {
      csrf = value.authenticated ? (value.csrf ?? '') : '';
      revision++;
    }
    return value;
  }
  const client: AgentClient = {
    downloaderProfiles: {
      list: () => request('/downloaders'),
      configure: (input) => request('/downloaders/configure', 'POST', input),
      action: (input) => request('/downloaders/action', 'POST', input),
    },
    resourceSites: {
      setDefault: (site) => request('/resource-sites/default', 'POST', { site }),
      list: () => request('/resource-sites'),
      configure: (input) => request('/resource-sites/configure', 'POST', input),
      verify: (site) => request('/resource-sites/verify', 'POST', { site }),
      setEnabled: (site, enabled) => request('/resource-sites/enabled', 'PUT', { site, enabled }),
      remove: async (site) => {
        await request('/resource-sites/remove', 'POST', { site });
      },
    },
    loadSettings: () => request('/settings'),
    getRuntime: () => request('/runtime'),
    connectGateway: (input) => request('/gateway/connect', 'POST', input),
    disconnectGateway: async () => {
      await request('/gateway/disconnect', 'POST');
    },
    testDownloader: (input) => request('/downloader/test', 'POST', input),
    resetDownloader: () => request('/downloader/reset', 'POST'),
    saveLocale: async (locale) => {
      await request('/locale', 'PUT', { locale });
    },
    getDownloadHistory: () => request('/download-history'),
    getQueue: () => request('/queue'),
    setQueuePage: async (cursor) => {
      await request('/queue/page', 'PUT', { cursor });
    },
    subscribeRuntime: async (receive, unavailable) => {
      if (!active || !csrf) throw 'managementSessionExpired';
      const stream = new EventSource('/api/events');
      streams.add(stream);
      stream.addEventListener('runtime', (event) => {
        if (!active || !csrf || !streams.has(stream)) return;
        try {
          receive(JSON.parse((event as MessageEvent<string>).data));
        } catch {
          unavailable();
        }
      });
      stream.addEventListener('session-expired', () => {
        if (streams.has(stream)) expire();
      });
      stream.onerror = () => {
        if (active && csrf && streams.has(stream)) unavailable();
      };
      return () => {
        stream.close();
        streams.delete(stream);
      };
    },
  };
  return {
    client,
    session: async () => {
      const current = revision;
      return receiveSession(await request<ManagementSession>('/session'), current);
    },
    login: async (password, username) => {
      const current = revision;
      return receiveSession(
        await request<ManagementSession>('/session', 'POST', {
          password,
          ...(username === undefined ? {} : { username }),
        }),
        current
      );
    },
    logout: async () => {
      await request('/session', 'DELETE');
      expire();
    },
    close: () => {
      active = false;
      revision++;
      csrf = '';
      streams.forEach((stream) => stream.close());
      streams.clear();
    },
  };
}
