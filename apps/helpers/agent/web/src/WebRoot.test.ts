// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import WebRoot from './WebRoot.vue';
import messages from '@movie-hub/helper-agent-ui/messages';
import type { AgentHost } from '@movie-hub/helper-agent-ui/transport';

vi.mock('@movie-hub/helper-agent-ui', () => ({
  AgentRoot: defineComponent({ name: 'AgentRoot', props: ['host', 'client'], template: '<div data-agent-root />' }),
}));
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.lang = '';
});
it.each(['zh-CN', 'en-US'] as const)(
  'supports %s login, clears the password and returns to login after deliberate logout',
  async (locale) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => reply({ authenticated: false, version: 'test' }));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = mount(WebRoot);
    try {
      await flushPromises();
      await wrapper.get('select').setValue(locale);
      expect(wrapper.text()).toContain(messages[locale].managementTitle);
      expect(wrapper.get('.management-hint').text()).toBe(messages[locale].managementPasswordHint);
      expect(document.documentElement.lang).toBe(locale);
      await wrapper.get('input').setValue('private-password');
      fetcher.mockResolvedValueOnce(reply({ error: { code: 'managementUnauthorized' } }, 401));
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(wrapper.get('input').element.value).toBe('');
      expect(wrapper.get('[role="alert"]').text()).toBe(messages[locale].managementUnauthorized);
      await wrapper.get('input').setValue('private-password');
      fetcher.mockResolvedValueOnce(reply({ authenticated: true, csrf: 'csrf', version: 'test' }));
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      const host = wrapper.findComponent({ name: 'AgentRoot' }).props('host') as AgentHost;
      fetcher.mockResolvedValueOnce(reply({ authenticated: false }));
      await host.signOut!();
      await flushPromises();
      expect(wrapper.find('[data-agent-root]').exists()).toBe(false);
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      expect(wrapper.get('input').element.value).toBe('');
    } finally {
      wrapper.unmount();
    }
  }
);
it('keeps the management screen visible if logout fails, and permits retry', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => reply({ authenticated: true, csrf: 'csrf', version: 'test' }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(WebRoot);
  try {
    await flushPromises();
    const host = wrapper.findComponent({ name: 'AgentRoot' }).props('host') as AgentHost;
    fetcher.mockRejectedValueOnce(Error('offline'));
    await expect(host.signOut!()).rejects.toBe('networkError');
    await flushPromises();
    expect(wrapper.find('[data-agent-root]').exists()).toBe(true);
    await host.signOut!();
    await flushPromises();
    expect(wrapper.find('[data-agent-root]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

it.each(['zh-CN', 'en-US'] as const)('requires and submits the configured username in %s', async (locale) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => reply({ authenticated: false, usernameRequired: true, version: 'test' }));
  vi.stubGlobal('fetch', fetcher);
  const wrapper = mount(WebRoot);
  try {
    await flushPromises();
    await wrapper.get('select').setValue(locale);
    expect(wrapper.text()).toContain(messages[locale].managementUsername);
    expect(wrapper.find('.management-hint').exists()).toBe(false);
    await wrapper.get('#management-password').setValue('private-password');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('#management-username').setValue('operator');
    fetcher.mockResolvedValueOnce(reply({ error: { code: 'managementUnauthorized' } }, 401));
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      username: 'operator',
      password: 'private-password',
    });
    expect(wrapper.get<HTMLInputElement>('#management-password').element.value).toBe('');
    expect(wrapper.get('[role="alert"]').text()).toBe(messages[locale].managementUnauthorized);
    await wrapper.get('#management-password').setValue('private-password');
    fetcher.mockResolvedValueOnce(reply({ authenticated: true, csrf: 'csrf', version: 'test' }));
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.find('[data-agent-root]').exists()).toBe(true);
    const host = wrapper.findComponent({ name: 'AgentRoot' }).props('host') as AgentHost;
    fetcher.mockResolvedValueOnce(reply({ authenticated: false }));
    await host.signOut!();
    await flushPromises();
    expect(wrapper.find('#management-username').exists()).toBe(true);
  } finally {
    wrapper.unmount();
  }
});
