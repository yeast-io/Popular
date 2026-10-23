// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import RemoteClientSettings from './RemoteClientSettings.vue';

const empty = { hasKey: false, canReadKey: false, authVersion: 0, deviceLimit: 1, devices: [], gatewayNotificationPending: false };
const configured = { ...empty, hasKey: true, canReadKey: true, authVersion: 1 };
const devices = ['device-a', 'device-b', 'device-c'].map((id) => {
  return ({ id, authVersion: 1, deviceVersion: 1, boundAt: '2026-10-21T00:00:00Z' });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(['en-US', 'zh-CN'] as const)('generates and displays a reusable RCCK with Agent instructions (%s)', async (locale) => {
  setLocale(locale);
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    return Response.json(init?.method === 'POST'
      ? { configuration: configured, apiKey: 'premote_secret' }
      : empty);
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(RemoteClientSettings);
  await flushPromises();
  await wrapper.get('.integration-disclosure').trigger('click');
  await wrapper.get('[data-action="generate"]').trigger('click');
  await flushPromises();
  const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(String(mutation[1]?.body))).toMatchObject({ expectedAuthVersion: 0 });
  expect(mutation[1]?.headers).toMatchObject({ 'accept-language': locale });
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('premote_secret');
  expect(wrapper.text()).toContain(locale === 'zh-CN'
    ? 'RCCK 密钥用于下载器代理与服务器之间通信验证'
    : 'The RCCK verifies communication between the downloader agent and the server.'
  );
  expect(wrapper.text()).not.toContain(locale === 'zh-CN' ? '密钥已加密保存' : 'Your key is stored encrypted');
  expect(wrapper.get('[data-action="show-key"]').attributes('aria-label')).toBe(
    locale === 'zh-CN' ? '隐藏密钥' : 'Hide key'
  );
  expect(wrapper.get('[data-action="copy-key"]').attributes('aria-label')).toBe(
    locale === 'zh-CN' ? '复制密钥' : 'Copy key'
  );
  expect(wrapper.find('.remote-key-input-actions').findAll('button')).toHaveLength(2);
  await wrapper.get('[data-action="show-key"]').trigger('click');
  expect(wrapper.get('input').attributes('type')).toBe('password');
  wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('can retrieve an existing RCCK after remount without regenerating or changing bindings (%s)', async (locale) => {
  setLocale(locale);
  const fetchMock = vi.fn(
    async (url: unknown) => {
      return Response.json(String(url).endsWith('/key') ? { apiKey: 'saved-key', authVersion: 1 } : configured);
    });
  vi.stubGlobal('fetch', fetchMock);
  for (let load = 0; load < 2; load++) {
    const wrapper = mount(RemoteClientSettings);
    await flushPromises();
    await wrapper.get('.integration-disclosure').trigger('click');
    expect((wrapper.get('input').element as HTMLInputElement).value).not.toBe('saved-key');
    await wrapper.get('[data-action="show-key"]').trigger('click');
    await flushPromises();
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('saved-key');
    expect(wrapper.get('input').attributes('type')).toBe('text');
    wrapper.unmount();
  }
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/key'))).toHaveLength(2);
});

it('copies the stored RCCK to clipboard without regenerating it and supports manual fallback', async () => {
  setLocale('en-US');
  const clipboard = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: unknown) => {
        return Response.json(String(url).endsWith('/key') ? { apiKey: 'copy-me', authVersion: 1 } : configured);
      })
  );
  const wrapper = mount(RemoteClientSettings);
  await flushPromises();
  await wrapper.get('.integration-disclosure').trigger('click');
  await wrapper.get('[data-action="copy-key"]').trigger('click');
  await flushPromises();
  expect(clipboard).toHaveBeenCalledWith('copy-me');
  expect(wrapper.text()).toContain('Key copied');
  clipboard.mockRejectedValue(new Error('clipboard blocked'));
  await wrapper.get('[data-action="copy-key"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('copy it manually');
  expect(wrapper.get('input').attributes('type')).toBe('text');
  wrapper.unmount();
});

it('unbinds only the selected device, preserves the key and other devices, and requires confirmation', async () => {
  setLocale('zh-CN');
  const state = { ...configured, deviceLimit: 3, devices };
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/key')) return Response.json({ apiKey: 'unchanged-key', authVersion: 1 });
    return Response.json(
      init?.method === 'POST' ? { ...state, devices: [devices[0], devices[2]], gatewayNotificationPending: true } : state
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(RemoteClientSettings);
  await flushPromises();
  await wrapper.get('.integration-disclosure').trigger('click');
  await wrapper.get('[data-action="show-key"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-device-id="device-b"]').trigger('click');
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  expect(wrapper.text()).toContain('RCCK 和其他设备继续有效');
  await wrapper.get('[data-action="confirm"]').trigger('click');
  await flushPromises();
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(String(post[0])).toContain('/devices/device-b/unbind');
  expect(JSON.parse(String(post[1]?.body))).toMatchObject({ expectedAuthVersion: 1, expectedDeviceVersion: 1 });
  expect(wrapper.findAll('[data-action="unbind"]')).toHaveLength(2);
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('unchanged-key');
  wrapper.unmount();
});

it.each(['revoke', 'regenerate'] as const)('confirms account-wide %s separately from unbinding a device', async (action) => {
  setLocale('en-US');
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    return Response.json(init?.method === 'POST'
      ? { configuration: { ...empty, authVersion: 2 }, apiKey: null }
      : { ...configured, devices }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(RemoteClientSettings);
  await flushPromises();
  await wrapper.get('.integration-disclosure').trigger('click');
  await wrapper.get(`[data-action="${action}"]`).trigger('click');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(wrapper.text()).toContain('all bound device authorizations');
  await wrapper.get('[data-action="confirm"]').trigger('click');
  await flushPromises();
  expect(String(fetchMock.mock.calls[1]![0])).toContain(`/remote-client/${action}`);
  expect(wrapper.find('[data-action="generate"]').exists()).toBe(true);
  expect(wrapper.find('input').exists()).toBe(false);
  wrapper.unmount();
});

it('clears a cached key if refresh observes another key generation', async () => {
  setLocale('en-US');
  let version = 1;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    return Response.json(String(url).endsWith('/key')
      ? { apiKey: `key-${version}`, authVersion: version }
      : { ...configured, authVersion: version }
    );
  })
  );
  const wrapper = mount(RemoteClientSettings);
  await flushPromises();
  await wrapper.get('.integration-disclosure').trigger('click');
  await wrapper.get('[data-action="show-key"]').trigger('click');
  await flushPromises();
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('key-1');
  version = 2;
  await wrapper.findAll('button').find((button) => button.text() === 'Refresh')!.trigger(
    'click'
  );
  await flushPromises();
  expect((wrapper.get('input').element as HTMLInputElement).value).not.toBe('key-1');
  await wrapper.get('[data-action="show-key"]').trigger('click');
  await flushPromises();
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('key-2');
  wrapper.unmount();
});

it('explains legacy keys and does not offer a fake copy/reveal action', async () => {
  setLocale('zh-CN');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...configured, canReadKey: false })));
  const wrapper = mount(RemoteClientSettings);
  await flushPromises();
  await wrapper.get('.integration-disclosure').trigger('click');
  expect(wrapper.text()).toContain('旧版本生成');
  expect(wrapper.find('[data-action="copy-key"]').exists()).toBe(false);
  expect(wrapper.find('[data-action="show-key"]').exists()).toBe(false);
  expect(wrapper.find('[data-action="regenerate"]').exists()).toBe(true);
  wrapper.unmount();
});

it('shows localized conflict and never displays a key from a failed response', async () => {
  setLocale('zh-CN');
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    return init?.method === 'POST'
      ? Response.json({ error: { code: 'CONFLICT' }, apiKey: 'must-not-show' }, { status: 409 })
      : Response.json(empty);
  })
  );
  const wrapper = mount(RemoteClientSettings);
  await flushPromises();
  await wrapper.get('.integration-disclosure').trigger('click');
  await wrapper.get('[data-action="generate"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('授权已变更');
  expect(wrapper.find('input').exists()).toBe(false);
  wrapper.unmount();
});

it('does not offer mutations after initial read fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network');
  }));
  const wrapper = mount(RemoteClientSettings);
  await flushPromises();
  expect(wrapper.find('[data-action="generate"]').exists()).toBe(false);
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('polls independent Agent/downloader states every minute and stops after unmount (%s)', async (locale) => {
  vi.useFakeTimers();
  setLocale(locale);
  let online = false;
  const fetchMock = vi.fn(async () => Response.json({ ...configured, devices: [{ ...devices[0],
    isAgentOnline: true, isAgentDownloaderOnline: online }] }));
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(RemoteClientSettings);
  await flushPromises();
  await wrapper.get('.integration-disclosure').trigger('click');
  expect(wrapper.text()).toContain(locale === 'zh-CN' ? '离线或不可用' : 'Offline or unavailable');
  online = true;
  await vi.advanceTimersByTimeAsync(60_000);
  await flushPromises();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(wrapper.text()).not.toContain(locale === 'zh-CN' ? '离线或不可用' : 'Offline or unavailable');
  wrapper.unmount();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
