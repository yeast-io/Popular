// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import AgentResourceSettings from './AgentResourceSettings.vue';

afterEach(() => vi.unstubAllGlobals());
it.each(['en-US', 'zh-CN'] as const)('enables local requests and restores cloud settings in %s', async (locale) => {
  setLocale(locale);
  let deviceId: string | null = null;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/me/remote-client'))
      return Response.json({ hasKey: true, devices: [{ id: 'device-1', isAgentOnline: true }] });
    if (init?.method === 'PUT') deviceId = JSON.parse(String(init.body)).deviceId;
    return Response.json({ deviceId });
  });
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(AgentResourceSettings, { slots: { default: '<div data-test="cloud">cloud</div>' } });
  expect(wrapper.find('[data-test=cloud]').exists()).toBe(false);
  await flushPromises();
  expect(wrapper.get('[role=switch]').attributes('aria-checked')).toBe('false');
  expect(wrapper.get('select').element.value).toBe('device-1');
  await wrapper.get('[role=switch]').trigger('click');
  await flushPromises();
  expect(deviceId).toBe('device-1');
  expect(wrapper.get('[role=switch]').attributes('aria-checked')).toBe('true');
  await wrapper.get('[role=switch]').trigger('click');
  await flushPromises();
  expect(deviceId).toBeNull();
  wrapper.unmount();
});
it('keeps active local mode on device discovery failure and permits disabling it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/me/remote-client')) throw Error('discovery failed');
      return Response.json({ deviceId: init?.method === 'PUT' ? null : 'device-1', unavailable: true });
    })
  );
  const wrapper = mount(AgentResourceSettings);
  await flushPromises();
  expect(wrapper.get('[role=switch]').attributes('aria-checked')).toBe('true');
  expect(wrapper.find('[role=alert]').exists()).toBe(true);
  await wrapper.get('[role=switch]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[role=switch]').attributes('aria-checked')).toBe('false');
  wrapper.unmount();
});
it('failed initial mode request never exposes cloud credential forms', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw Error('unavailable');
    })
  );
  const wrapper = mount(AgentResourceSettings, { slots: { default: '<div data-test="cloud">cloud</div>' } });
  await flushPromises();
  expect(wrapper.find('[data-test=cloud]').exists()).toBe(false);
  expect(wrapper.get<HTMLButtonElement>('[role=switch]').element.disabled).toBe(true);
  wrapper.unmount();
});
