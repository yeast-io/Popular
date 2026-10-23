// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';
import messages from './locales/messages.json';
import type { Locale, Settings, Snapshot } from './settings.types';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => false }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setTitle: vi.fn() }) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

function snapshot(locale: Locale, overrides: Partial<Settings> = {}): Snapshot {
  return { settings: { locale, gatewayUrl: '', provider: 'qbittorrent',
    downloaderUrl: 'http://127.0.0.1:8080/', username: '', authMode: 'password',
    autostart: true, gatewayEnabled: true, downloaderConfigured: false, ...overrides },
  hasApiKey: false, hasPassword: false };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  describe(locale, () => {
    it('submits the chosen downloader API key separately from Gateway credentials', async () => {
      const initial = snapshot(locale);
      invoke.mockImplementation(async (command: string, args?: { request?: Record<string, unknown> }) => {
        if (command === 'load_settings') return initial;
        if (command === 'test_downloader') return { ...initial,
          settings: { ...initial.settings, ...args!.request, downloaderConfigured: true }, hasPassword: true };
        return { page: 'settings', service: 'unconfigured', downloader: 'disconnected', binding: 'unbound' };
      });
      const wrapper = mount(App);
      try {
        await flushPromises();
        const credentials = wrapper.get('.credentials');
        expect(credentials.findAll('label').map((label) => label.text())).toEqual([
          expect.stringContaining(messages[locale].authMode), messages[locale].username, messages[locale].password,
        ]);
        await wrapper.get('#downloader-host').setValue('192.168.0.73');
        await credentials.get('select').setValue('apiKey');
        expect(credentials.find('[autocomplete="username"]').exists()).toBe(false);
        expect(credentials.text()).toContain(messages[locale].downloaderApiKey);
        expect(wrapper.text()).toContain(messages[locale].apiKeyHint);
        await credentials.get('input[type="password"]').setValue('qbt_test-only-key');
        await wrapper.findAll('form')[1]!.trigger('submit');
        await flushPromises();
        expect(invoke).toHaveBeenCalledWith('test_downloader', { request: {
          provider: 'qbittorrent', downloaderUrl: 'http://192.168.0.73:8080',
          username: '', authMode: 'apiKey', password: { action: 'set', value: 'qbt_test-only-key' },
        } });
        expect(invoke.mock.calls.some(([command]) => command === 'connect_device')).toBe(false);
      } finally { wrapper.unmount(); }
    });

    it('clears the draft secret when switching modes and restores saved mode on cancel', async () => {
      const initial = { ...snapshot(locale, { downloaderConfigured: true, authMode: 'apiKey', username: 'saved-user' }), hasPassword: true };
      invoke.mockImplementation(async (command: string) => command === 'load_settings'
        ? initial
        : { page: 'settings', service: 'unconfigured', downloader: 'online', binding: 'unbound' });
      const wrapper = mount(App);
      try {
        await flushPromises();
        const downloaderForm = wrapper.findAll('form')[1]!;
        await downloaderForm.get('.card-summary button').trigger('click');
        await wrapper.get('.credentials select').setValue('password');
        const password = wrapper.get('.credentials input[type="password"]');
        expect(password.attributes('placeholder')).toBe(messages[locale].newSecret);
        expect((password.element as HTMLInputElement).value).toBe('');
        await password.setValue('draft-password');
        await wrapper.get('.credentials select').setValue('apiKey');
        expect((wrapper.get('.credentials input[type="password"]').element as HTMLInputElement).value).toBe('********');
        await wrapper.get('.credentials select').setValue('password');
        const cancel = downloaderForm.findAll('button').find((button) => button.text() === messages[locale].cancel)!;
        await cancel.trigger('click');
        await downloaderForm.get('.card-summary button').trigger('click');
        expect((wrapper.get('.credentials select').element as HTMLSelectElement).value).toBe('apiKey');
        await wrapper.get('input[value="transmission"]').setValue();
        expect(wrapper.find('.credentials select').exists()).toBe(false);
        expect(wrapper.get('.credentials').text()).toContain(messages[locale].username);
        expect((wrapper.get('.credentials input[type="password"]').element as HTMLInputElement).value).toBe('');
      } finally { wrapper.unmount(); }
    });
  });
}
