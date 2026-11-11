// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { createDesktopAgentClient, createDesktopAgentHost } from './desktop-agent.client';

const { invoke, listen, setTitle } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), setTitle: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTitle }) }));
beforeEach(() => {
  vi.resetAllMocks();
});
it('maps business operations to the existing native boundary without mixing secrets', async () => {
  const client = createDesktopAgentClient();
  const request = {
    provider: 'qbittorrent' as const,
    authMode: 'apiKey' as const,
    downloaderUrl: 'http://nas:8080',
    username: '',
    password: { action: 'set' as const, value: 'test-secret' },
  };
  await client.testDownloader(request);
  expect(invoke).toHaveBeenLastCalledWith('test_downloader', { request });
  await client.connectGateway({ gatewayUrl: 'https://gateway.example', locale: 'zh-CN', apiKey: { action: 'keep' } });
  expect(invoke).toHaveBeenLastCalledWith('connect_device', {
    request: { gatewayUrl: 'https://gateway.example', locale: 'zh-CN', apiKey: { action: 'keep' } },
  });
  await client.setQueuePage(null);
  expect(invoke).toHaveBeenLastCalledWith('queue_page', { cursor: null });
  await client.saveLocale('zh-CN');
  expect(invoke).toHaveBeenLastCalledWith('save_locale', { locale: 'zh-CN' });
});
it('adapts native tray navigation into shared pages and returns the native cleanup', async () => {
  const stop = vi.fn();
  listen.mockResolvedValue(stop);
  const host = createDesktopAgentHost();
  const navigate = vi.fn();
  expect(await host.onNavigate!(navigate)).toBe(stop);
  const callback = listen.mock.calls[0]![1];
  callback({ payload: 'queue' });
  callback({ payload: 'settings' });
  callback({ payload: 'invalid' });
  expect(navigate.mock.calls).toEqual([['tasks'], ['settings']]);
  await host.setAutostart!(false);
  expect(invoke).toHaveBeenLastCalledWith('set_autostart', { enabled: false });
  await host.setTitle!('Agent');
  expect(setTitle).toHaveBeenCalledWith('Agent');
});
it('maps local site operations to fixed native commands', async () => {
  const sites = createDesktopAgentClient().resourceSites!;
  await sites.list();
  expect(invoke).toHaveBeenLastCalledWith('resource_sites_list');
  const request = {
    site: 'hdarea' as const,
    baseUrl: 'https://site.example/',
    credential: { action: 'set' as const, value: 'local-cookie' },
    passkey: { action: 'set' as const, value: 'local-passkey' },
  };
  await sites.configure(request);
  expect(invoke).toHaveBeenLastCalledWith('resource_site_configure', { request });
  await sites.verify('hdarea');
  expect(invoke).toHaveBeenLastCalledWith('resource_site_verify', { request: { site: 'hdarea' } });
  await sites.setEnabled('hdarea', false);
  expect(invoke).toHaveBeenLastCalledWith('resource_site_enabled', { request: { site: 'hdarea', enabled: false } });
  await sites.remove('hdarea');
  expect(invoke).toHaveBeenLastCalledWith('resource_site_remove', { request: { site: 'hdarea' } });
});
