// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createWebAgentClient } from './web-agent.client';

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function fixture() {
  const expired = vi.fn();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response({ authenticated: true, csrf: 'memory-only-csrf', version: 'test' }));
  vi.stubGlobal('fetch', fetcher);
  return { transport: createWebAgentClient({ onSessionExpired: expired }), expired, fetcher };
}
afterEach(() => vi.unstubAllGlobals());
it('keeps session tokens in memory and supplies CSRF for writes and logout', async () => {
  const { transport, fetcher, expired } = fixture();
  const set = vi.spyOn(Storage.prototype, 'setItem');
  await expect(transport.client.saveLocale('zh-CN')).rejects.toBe('managementSessionExpired');
  expect(fetcher).not.toHaveBeenCalled();
  await transport.login('private-password');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: 'same-origin',
    cache: 'no-store',
    body: JSON.stringify({ password: 'private-password' }),
  });
  await transport.client.saveLocale('zh-CN');
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
    headers: { 'x-csrf-token': 'memory-only-csrf' },
    body: '{"locale":"zh-CN"}',
  });
  await transport.logout();
  expect(fetcher.mock.calls[2]?.[1]).toMatchObject({
    method: 'DELETE',
    headers: { 'x-csrf-token': 'memory-only-csrf' },
  });
  expect(expired).toHaveBeenCalledTimes(1);
  await expect(transport.client.resetDownloader()).rejects.toBe('managementSessionExpired');
  expect(set).not.toHaveBeenCalled();
  set.mockRestore();
  transport.close();
});
it('preserves the session after a failed logout so it can be retried', async () => {
  const { transport, fetcher, expired } = fixture();
  await transport.session();
  fetcher.mockRejectedValueOnce(new TypeError('offline'));
  await expect(transport.logout()).rejects.toBe('networkError');
  expect(expired).not.toHaveBeenCalled();
  await transport.logout();
  expect(expired).toHaveBeenCalledOnce();
  transport.close();
});
it('expires protected requests on 401 but does not expire for an incorrect login password', async () => {
  const { transport, fetcher, expired } = fixture();
  await transport.session();
  fetcher.mockResolvedValueOnce(response({ error: { code: 'managementUnauthorized' } }, 401));
  await expect(transport.login('wrong')).rejects.toBe('managementUnauthorized');
  expect(expired).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(response({ error: { code: 'managementUnauthorized' } }, 401));
  await expect(transport.client.getRuntime()).rejects.toBe('managementUnauthorized');
  expect(expired).toHaveBeenCalledOnce();
  transport.close();
});
it('closes event streams on expiry and ignores events after closure', async () => {
  class Stream extends EventTarget {
    static instances: Stream[] = [];
    close = vi.fn();
    onerror: (() => void) | null = null;

    constructor(public url: string) {
      super();
      Stream.instances.push(this);
    }
  }
  vi.stubGlobal('EventSource', Stream);
  const { transport, expired } = fixture();
  const receive = vi.fn();
  const unavailable = vi.fn();
  await transport.session();
  await transport.client.subscribeRuntime!(receive, unavailable);
  const stream = Stream.instances[0]!;
  expect(stream.url).toBe('/api/events');
  stream.dispatchEvent(new MessageEvent('runtime', { data: '{"service":"online"}' }));
  expect(receive).toHaveBeenCalledWith({ service: 'online' });
  stream.dispatchEvent(new Event('session-expired'));
  expect(expired).toHaveBeenCalledOnce();
  expect(stream.close).toHaveBeenCalledOnce();
  stream.dispatchEvent(new MessageEvent('runtime', { data: '{"service":"online"}' }));
  expect(receive).toHaveBeenCalledTimes(1);
  transport.close();
});
it('does not restore access when a pending session response arrives after unmount', async () => {
  const { transport, fetcher } = fixture();
  let finish!: (value: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const pending = transport.session();
  transport.close();
  finish(response({ authenticated: true, csrf: 'stale', version: 'test' }));
  await pending;
  await expect(transport.client.saveLocale('en-US')).rejects.toBe('managementSessionExpired');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('works on HTTP LAN origins where crypto.randomUUID is unavailable', async () => {
  vi.stubGlobal('crypto', {});
  const { transport, fetcher } = fixture();
  await transport.session();
  await transport.client.saveLocale('en-US');
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: { 'x-csrf-token': 'memory-only-csrf' } });
  expect((fetcher.mock.calls[1]?.[1]?.headers as Record<string, string>)['x-request-id']).toBeUndefined();
  transport.close();
});
it('does not let a previous session HTTP failure log out a newly authenticated session', async () => {
  const { transport, fetcher, expired } = fixture();
  await transport.login('first-password');
  let finish!: (value: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const oldRead = transport.client.getRuntime();
  await transport.logout();
  await transport.login('new-password');
  finish(response({ error: { code: 'managementUnauthorized' } }, 401));
  await expect(oldRead).rejects.toBe('managementUnauthorized');
  expect(expired).toHaveBeenCalledTimes(1);
  await transport.client.saveLocale('en-US');
  transport.close();
});
it('uses fixed authenticated same-origin routes for local site operations', async () => {
  const { transport, fetcher } = fixture();
  await transport.session();
  const sites = transport.client.resourceSites!;
  await sites.list();
  expect(fetcher).toHaveBeenLastCalledWith('/api/resource-sites', expect.objectContaining({ method: 'GET' }));
  const input = {
    site: 'mteam' as const,
    baseUrl: 'https://api.m-team.cc',
    credential: { action: 'set' as const, value: 'local-site-key' },
    passkey: { action: 'keep' as const },
  };
  await sites.configure(input);
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/resource-sites/configure',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-csrf-token': 'memory-only-csrf' }),
      body: JSON.stringify(input),
    })
  );
  await sites.verify('mteam');
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/resource-sites/verify',
    expect.objectContaining({ method: 'POST', body: '{"site":"mteam"}' })
  );
  await sites.setEnabled('mteam', false);
  expect(fetcher).toHaveBeenLastCalledWith('/api/resource-sites/enabled', expect.objectContaining({ method: 'PUT' }));
  await sites.remove('mteam');
  expect(fetcher).toHaveBeenLastCalledWith('/api/resource-sites/remove', expect.objectContaining({ method: 'POST' }));
  transport.close();
});
