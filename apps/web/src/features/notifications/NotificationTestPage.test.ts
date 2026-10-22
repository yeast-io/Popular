// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import NotificationTestPage from './NotificationTestPage.vue';

beforeEach(() => {
  setLocale('en-US');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const channels = [
  { id: 'telegram', name: 'Telegram', configured: true },
  { id: 'whatsapp', name: 'WhatsApp', configured: true },
  { id: 'future', name: 'Future', configured: false },
];
it('renders one button per available channel and sends only the selected channel with independent cooldowns', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const channel = init?.body ? JSON.parse(init.body as string).channel : '';
    return Response.json(
      init?.method === 'POST'
        ? { results: [{ channel, sent: channel !== 'whatsapp' }] }
        : {
            channels,
            items: [
              {
                id: 'download',
                tmdbId: 7,
                title: 'Movie',
                resourceName: 'release',
                provider: 'qbittorrent',
                downloaderName: 'Seedbox',
                totalBytes: 1024,
              },
            ],
            page: 1,
            hasMore: false,
          }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(NotificationTestPage);
  await flushPromises();
  expect(wrapper.text()).toContain('Movie');
  expect(wrapper.text()).toContain('Seedbox');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(wrapper.findAll('article button')).toHaveLength(3);
  expect(wrapper.get('[data-channel="telegram"]').text()).toBe('Send Telegram test');
  expect(wrapper.get('[data-channel="future"]').text()).toContain('Not linked');
  expect(wrapper.get('[data-channel="future"]').attributes('disabled')).toBeDefined();
  await wrapper.get('[data-channel="telegram"]').trigger('click');
  await flushPromises();
  expect(fetchMock.mock.calls[1]?.[0]).toContain('/download/send');
  const request = fetchMock.mock.calls[1]?.[1];
  expect(request?.credentials).toBe('include');
  expect(JSON.parse(request?.body as string)).toEqual({ channel: 'telegram' });
  expect(wrapper.text()).toContain('Accepted by channel');
  expect(wrapper.get('[data-channel="telegram"]').attributes('disabled')).toBeDefined();
  expect(wrapper.get('[data-channel="whatsapp"]').attributes('disabled')).toBeUndefined();
  await vi.advanceTimersByTimeAsync(5000);
  await wrapper.get('[data-channel="whatsapp"]').trigger('click');
  await flushPromises();
  expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string)).toEqual({ channel: 'whatsapp' });
  expect(wrapper.text()).toContain('Send unconfirmed');
  expect(wrapper.text()).toContain('Accepted by channel');
  await vi.advanceTimersByTimeAsync(25000);
  expect(wrapper.get('[data-channel="telegram"]').attributes('disabled')).toBeUndefined();
  expect(wrapper.get('[data-channel="whatsapp"]').attributes('disabled')).toBeDefined();
  await vi.advanceTimersByTimeAsync(5000);
  expect(wrapper.get('[data-channel="whatsapp"]').attributes('disabled')).toBeUndefined();
  wrapper.unmount();
  const count = fetchMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetchMock).toHaveBeenCalledTimes(count);
});
it('shows empty data and request errors without automatically sending any messages', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ channels, items: [], page: 1, hasMore: false }))
  );
  const wrapper = mount(NotificationTestPage);
  await flushPromises();
  expect(wrapper.text()).toContain('No saved completed downloads.');
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  wrapper.unmount();
});
