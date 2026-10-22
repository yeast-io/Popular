// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import DownloaderSettings from './DownloaderSettings.vue';

beforeEach(() => setLocale('en-US'));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('adds a named second qBittorrent instance while keeping the first', async () => {
  const first = {
    provider: 'qbittorrent', status: 'configured_valid',
    downloaderInstanceId: '00000000-0000-4000-8000-000000000001', name: 'Home',
    baseUrl: 'https://home.example.com', authMethod: 'api_key', apiKeyMasked: '••••',
  };
  const second = {
    ...first, downloaderInstanceId: '00000000-0000-4000-8000-000000000002',
    name: 'Seedbox', baseUrl: 'https://seedbox.example.com',
  };
  const saved = [first];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/qbittorrent/instances') && init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ name: 'Seedbox', baseUrl: second.baseUrl, authMethod: 'api_key', apiKey: 'secret' });
      saved.push(second);
      return Response.json(second, { status: 201 });
    }
    if (url.endsWith('/qbittorrent/instances')) return Response.json(saved);
    if (url.endsWith('/transmission/instances')) return Response.json([]);
    if (url.endsWith('/integration-preferences')) return Response.json({ defaults: { downloader: first.downloaderInstanceId }, choices: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(DownloaderSettings);
  await flushPromises();
  expect(wrapper.text()).toContain('Home');
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  wrapper.vm.openAddDialog();
  await flushPromises();
  expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true');
  await wrapper.get('.downloader-type-option').trigger('click');
  expect(wrapper.get('.downloader-type-option').classes()).toContain('is-selected');
  await wrapper.get('#qbittorrent-name').setValue('Seedbox');
  await wrapper.get('#qbittorrent-base-url').setValue(second.baseUrl);
  await wrapper.get('#qbittorrent-api-key').setValue('secret');
  await wrapper.get('[role="dialog"] form').trigger('submit');
  await flushPromises();
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/qbittorrent/instances') && init?.method === 'POST')).toBe(true);
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  expect(wrapper.findAll('.connection-copy h3').map((node) => node.text())).toEqual(['Home', 'Seedbox']);
  wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('opens logo choices in a dialog for a new user (%s)', async (locale) => {
  setLocale(locale);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/instances')) return Response.json([]);
    throw new Error(`Unexpected request: ${String(input)}`);
  }));
  const wrapper = mount(DownloaderSettings);
  await flushPromises();
  expect(wrapper.find('.downloader-type-picker').exists()).toBe(false);
  wrapper.vm.openAddDialog();
  await flushPromises();
  expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true');
  const choices = wrapper.findAll('.downloader-type-option');
  expect(choices.map((choice) => choice.text())).toEqual(['qBittorrent', 'Transmission']);
  expect(choices.every((choice) => choice.find('img').exists())).toBe(true);
  expect(wrapper.text()).not.toContain('No downloaders configured');
  expect(wrapper.text()).not.toContain('尚未配置下载器');
  await choices[1]!.trigger('click');
  expect(choices[1]!.classes()).toContain('is-selected');
  expect(choices[1]!.attributes('aria-pressed')).toBe('true');
  await wrapper.get('.downloader-add-close').trigger('click');
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  wrapper.unmount();
});
