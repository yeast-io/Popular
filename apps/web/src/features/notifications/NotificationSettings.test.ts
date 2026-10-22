// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { h } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import NotificationSettings from './NotificationSettings.vue';
import DownloadNotificationSwitch from './DownloadNotificationSwitch.vue';

interface Controls {
  enabledChannels: string[];
  disabled: boolean;
  toggleChannel: (id: string, enabled: boolean) => Promise<void>;
}
const channels = [
  { id: 'whatsapp', name: 'WhatsApp', configured: true },
  { id: 'telegram', name: 'Telegram', configured: true },
];
function mountControls() {
  return mount(NotificationSettings, { slots: { default: (controls: Controls) => {
    return channels.map((channel) => {
      return h(
        DownloadNotificationSwitch,
        { key: channel.id, channel: channel.name, enabled: controls.enabledChannels.includes(
          channel.id
        ), disabled: controls.disabled,
        onChange: (enabled: boolean) => controls.toggleChannel(channel.id, enabled) }
      );
    });
  } } });
}
beforeEach(() => setLocale('en-US'));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['en-US', 'zh-CN'] as const)('independently saves each channel and disables notifications when both are off in %s', async (locale) => {
  setLocale(locale);
  let preferences = { enabled: false, defaultChannel: 'whatsapp', additionalChannels: [] as string[] };
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') preferences = JSON.parse(String(init.body));
    return Response.json({ ...preferences, channels });
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mountControls();
  try {
    await flushPromises();
    const switches = wrapper.findAll<HTMLInputElement>('input[role="switch"]');
    expect(wrapper.find('select').exists()).toBe(false);
    await switches[0]!.setValue(true);
    await flushPromises();
    expect(preferences).toEqual({ enabled: true, defaultChannel: 'whatsapp', additionalChannels: [] });
    await switches[1]!.setValue(true);
    await flushPromises();
    expect(preferences).toEqual({ enabled: true, defaultChannel: 'whatsapp', additionalChannels: ['telegram'] });
    await switches[0]!.setValue(false);
    await flushPromises();
    expect(preferences).toEqual({ enabled: true, defaultChannel: 'telegram', additionalChannels: [] });
    expect(switches[1]!.element.checked).toBe(true);
    await switches[1]!.setValue(false);
    await flushPromises();
    expect(preferences).toEqual({ enabled: false, defaultChannel: 'telegram', additionalChannels: [] });
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes).toHaveLength(4);
    expect(writes.every(([, init]) => init?.credentials === 'include')).toBe(true);
    expect(wrapper.get('[role="status"]').text()).toBe(
      locale === 'zh-CN' ? '通知设置已保存。' : 'Notification preferences saved.'
    );
  } finally { wrapper.unmount(); }
});

it('restores the saved switch state when an update fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    return init?.method === 'PUT'
      ? Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 })
      : Response.json({ enabled: true, defaultChannel: 'whatsapp', additionalChannels: [], channels });
  })
  );
  const wrapper = mountControls();
  try {
    await flushPromises();
    const toggle = wrapper.get<HTMLInputElement>('input[role="switch"]');
    await toggle.setValue(false);
    await flushPromises();
    expect(toggle.element.checked).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toBeTruthy();
  } finally { wrapper.unmount(); }
});

it('keeps switches disabled until saved preferences arrive even if availability arrives first', async () => {
  let resolveInitial!: (response: Response) => void;
  const initial = new Promise<Response>((resolve) => {
    resolveInitial = resolve;
  });
  const preferences = { enabled: true, defaultChannel: 'whatsapp', additionalChannels: [], channels };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockReturnValueOnce(initial).mockImplementation(async () => Response.json(preferences))
  );
  const wrapper = mountControls();
  try {
    await wrapper.vm.refresh();
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>('input').element.disabled).toBe(true);
    resolveInitial(Response.json(preferences));
    await flushPromises();
    expect(wrapper.get<HTMLInputElement>('input').element.checked).toBe(true);
    expect(wrapper.get<HTMLInputElement>('input').element.disabled).toBe(false);
  } finally { wrapper.unmount(); }
});
