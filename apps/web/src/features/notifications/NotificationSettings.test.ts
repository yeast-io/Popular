// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import NotificationSettings from './NotificationSettings.vue';
beforeEach(() => setLocale('en-US'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('saves enabled preferences and default plus extra channels, with owner determined by the session', async () => {
  const channels = [{ id: 'whatsapp', name: 'WhatsApp', configured: true }, { id: 'future', name: 'Future channel', configured: true }];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ enabled: false, defaultChannel: 'whatsapp', additionalChannels: [], channels, ...(init?.body ? JSON.parse(String(init.body)) : {}) }));
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(NotificationSettings); await flushPromises();
  await wrapper.get('input[role="switch"]').setValue(true);
  await wrapper.get('fieldset input').setValue(true);
  await wrapper.get('form').trigger('submit'); await flushPromises();
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(call?.[1]?.credentials).toBe('include');
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({ enabled: true, defaultChannel: 'whatsapp', additionalChannels: ['future'] });
  expect(wrapper.text()).toContain('Notification preferences saved.');
  wrapper.unmount();
});

it('requires linking selected channels and refreshes availability without resetting unsaved preferences', async () => {
  let configured = false;
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ enabled: false, defaultChannel: 'whatsapp', additionalChannels: [], channels: [{ id: 'whatsapp', name: 'WhatsApp', configured }] })));
  const wrapper = mount(NotificationSettings); await flushPromises();
  await wrapper.get('input[role="switch"]').setValue(true);
  expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
  expect(wrapper.text()).toContain('Link all selected channels');
  configured = true;
  await wrapper.vm.refresh(); await flushPromises();
  expect((wrapper.get('input[role="switch"]').element as HTMLInputElement).checked).toBe(true);
  expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
  wrapper.unmount();
});

it('keeps controls loading until saved preferences arrive, even if channel availability refresh finishes first', async () => {
  let resolveInitial!: (response: Response) => void;
  const initial = new Promise<Response>(resolve => { resolveInitial = resolve; });
  const preferences = { enabled: true, defaultChannel: 'whatsapp', additionalChannels: [], channels: [{ id: 'whatsapp', name: 'WhatsApp', configured: true }] };
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(initial).mockResolvedValue(Response.json(preferences)));
  const wrapper = mount(NotificationSettings);
  await wrapper.vm.refresh(); await flushPromises();
  expect(wrapper.find('input[role="switch"]').exists()).toBe(false);
  resolveInitial(Response.json(preferences)); await flushPromises();
  expect((wrapper.get('input[role="switch"]').element as HTMLInputElement).checked).toBe(true);
  expect(wrapper.find('select').exists()).toBe(false);
  expect(wrapper.text()).toContain('Linked');
  wrapper.unmount();
});
