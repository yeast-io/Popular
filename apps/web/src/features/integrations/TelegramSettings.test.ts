// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import TelegramSettings from './TelegramSettings.vue';

beforeEach(() => {
  setLocale('en-US');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('opens a binding link, polls owner status, tests and requires confirmation before unlinking', async () => {
  let state: Record<string, string> = { status: 'unbound' };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (init?.method === 'DELETE') {
        state = { status: 'unbound' };
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/bind')) {
        state = { status: 'pending', expiresAt: new Date(Date.now() + 600000).toISOString() };
        return Response.json({ ...state, bindingUrl: 'https://t.me/PopularBot?start=secret' });
      }
      if (url.endsWith('/test')) return Response.json({ messageId: '1' });
      return Response.json(state);
    })
  );
  const wrapper = mount(TelegramSettings);
  await flushPromises();
  await wrapper.get('.integration-disclosure').trigger('click');
  await flushPromises();
  expect(wrapper.get('a').attributes('href')).toBe('https://t.me/PopularBot?start=secret');
  expect(wrapper.text()).toContain('press Start');
  state = { status: 'connected', account: '@alice' };
  await vi.advanceTimersByTimeAsync(3000);
  await flushPromises();
  expect(wrapper.find('a').exists()).toBe(false);
  expect(wrapper.text()).toContain('@alice');
  await wrapper.get('button.primary').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Telegram accepted');
  expect(calls.find((row) => row.url.endsWith('/test'))?.init?.body).toBeUndefined();
  await wrapper.get('button.danger').trigger('click');
  expect(calls.some((row) => row.init?.method === 'DELETE')).toBe(false);
  await wrapper.get('button.danger').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Not linked');
  wrapper.unmount();
  const count = calls.length;
  await vi.advanceTimersByTimeAsync(9000);
  expect(calls).toHaveLength(count);
});
it('hides expired binding links and clears links when refresh fails', async () => {
  let broken = false;
  let expired = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (broken) throw new Error('offline');
      if (url.endsWith('/bind'))
        return Response.json({
          status: 'pending',
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          bindingUrl: 'https://t.me/PopularBot?start=secret',
        }
        );
      return Response.json({ status: expired ? 'unbound' : 'pending' });
    })
  );
  const wrapper = mount(TelegramSettings);
  await flushPromises();
  await wrapper.get('button.primary').trigger('click');
  await flushPromises();
  expect(wrapper.find('a').exists()).toBe(true);
  broken = true;
  await vi.advanceTimersByTimeAsync(3000);
  await flushPromises();
  expect(wrapper.find('a').exists()).toBe(false);
  broken = false;
  await wrapper.get('button.primary').trigger('click');
  await flushPromises();
  expired = true;
  await vi.advanceTimersByTimeAsync(3000);
  await flushPromises();
  expect(wrapper.find('a').exists()).toBe(false);
  expect(wrapper.text()).toContain('Not linked');
  wrapper.unmount();
});
it('does not expose configuration or binding actions when server has no Bot', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ status: 'unavailable' }))
  );
  const wrapper = mount(TelegramSettings);
  await flushPromises();
  expect(wrapper.text()).toContain('Not configured');
  expect(wrapper.find('button.primary').exists()).toBe(false);
  wrapper.unmount();
});
