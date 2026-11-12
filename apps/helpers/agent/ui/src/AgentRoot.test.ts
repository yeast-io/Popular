// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import AgentRoot from './AgentRoot.vue';
import messages from './locales/messages.json';
import type { DownloaderProfile } from './features/downloaders/downloader-profiles.types';
import type { Locale, Settings, Snapshot, RuntimeStatus } from './settings.types';
import type { AgentClient, AgentHost, AgentPage } from './transport/agent-transport.types';

const mounted: VueWrapper[] = [];
function snapshot(locale: Locale, overrides: Partial<Settings> = {}): Snapshot {
  return {
    settings: {
      locale,
      gatewayUrl: '',
      provider: 'qbittorrent',
      downloaderUrl: 'http://127.0.0.1:8080/',
      username: '',
      authMode: 'password',
      autostart: true,
      gatewayEnabled: true,
      downloaderConfigured: false,
      ...overrides,
    },
    hasApiKey: false,
    hasPassword: false,
  };
}
function setup(initial: Snapshot) {
  let saved = structuredClone(initial);
  const runtime: RuntimeStatus = {
    service: 'unconfigured',
    downloader: 'online',
    binding: 'unbound',
    deviceId: null,
    preferenceError: null,
  };
  const client: AgentClient = {
    loadSettings: vi.fn(async () => structuredClone(saved)),
    getRuntime: vi.fn(async () => ({ ...runtime })),
    connectGateway: vi.fn(async (request) => {
      saved = { ...saved, settings: { ...saved.settings, gatewayUrl: request.gatewayUrl }, hasApiKey: true };
      return structuredClone(saved);
    }),
    disconnectGateway: vi.fn(async () => {}),
    testDownloader: vi.fn(async (request) => {
      const { password, ...settings } = request;
      saved = {
        ...saved,
        settings: { ...saved.settings, ...settings, downloaderConfigured: true },
        hasPassword: password.action === 'set' || saved.hasPassword,
      };
      return structuredClone(saved);
    }),
    resetDownloader: vi.fn(async () => {
      saved = snapshot(initial.settings.locale);
      return structuredClone(saved);
    }),
    saveLocale: vi.fn(async () => {}),
    getQueue: vi.fn(async () => ({ snapshot: null, stale: true, loading: false })),
    setQueuePage: vi.fn(async () => {}),
  };
  const host: AgentHost = {
    version: '0.1.1-beta.1',
    openDocumentation: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
  };
  function render() {
    const wrapper = mount(AgentRoot, { props: { client, host } });
    mounted.push(wrapper);
    return wrapper;
  }
  return { client, host, runtime, render };
}
async function navigate(wrapper: VueWrapper, page: AgentPage) {
  await wrapper.get(`[data-page="${page}"]`).trigger('click');
  await flushPromises();
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  describe(locale, () => {
    it('switches downloader defaults, toggles capsules and adds a separately saved configuration', async () => {
      const base = snapshot(locale, { downloaderConfigured: true });
      const f = setup(base);
      let rows: DownloaderProfile[] = [
        { id: 'a', provider: 'qbittorrent', downloaderUrl: 'http://first:8080', username: '', authMode: 'password', enabled: true, isDefault: true, hasPassword: true },
        { id: 'b', provider: 'transmission', downloaderUrl: 'http://second:9091/transmission/rpc', username: '', authMode: 'password', enabled: true, isDefault: false, hasPassword: true },
      ];
      function activeSnapshot() {
        const row = rows.find((row) => row.isDefault)!;
        return { ...base, settings: { ...base.settings, provider: row.provider, downloaderUrl: row.downloaderUrl, downloaderConfigured: row.enabled } };
      }
      f.client.downloaderProfiles = {
        list: vi.fn(async () => structuredClone(rows)),
        action: vi.fn(async (input) => {
          rows = rows.map((row) => ({ ...row, ...(input.operation === 'default' ? { isDefault: row.id === input.id } : row.id === input.id ? { enabled: input.enabled! } : {}) }));
          return activeSnapshot();
        }),
        configure: vi.fn(async () => activeSnapshot()),
      };
      const wrapper = f.render();
      await flushPromises();
      await navigate(wrapper, 'downloaders');
      expect(wrapper.findAll('[role=switch]')).toHaveLength(2);
      await wrapper.get('[data-downloader=b] .local-site-controls button:nth-child(2)').trigger('click');
      await flushPromises();
      expect(f.client.downloaderProfiles.action).toHaveBeenLastCalledWith({ id: 'b', operation: 'default' });
      expect(wrapper.get('[data-downloader=b]').text()).toContain(messages[locale].defaultItem);
      await wrapper.get('[data-downloader=a] [role=switch]').trigger('click');
      await flushPromises();
      expect(f.client.downloaderProfiles.action).toHaveBeenLastCalledWith({ id: 'a', operation: 'enabled', enabled: false });
      expect(wrapper.get('[data-downloader=a] [role=switch]').attributes('aria-checked')).toBe('false');
      await wrapper.findAll('button').find((button) => button.text() === messages[locale].addDownloader)!.trigger('click');
      await wrapper.get('form input[type=text]').setValue('http://third:8080');
      await wrapper.get('form input[type=password]').setValue('third-secret');
      await navigate(wrapper, 'overview');
      expect(wrapper.text()).toContain(messages[locale].unsavedChanges);
      await navigate(wrapper, 'downloaders');
      expect((wrapper.get('form input[type=text]').element as HTMLInputElement).value).toBe('http://third:8080');
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(f.client.downloaderProfiles.configure).toHaveBeenCalledWith({ id: null, configuration: { provider: 'qbittorrent', downloaderUrl: 'http://third:8080', username: '', authMode: 'password', password: { action: 'set', value: 'third-secret' } } });
      expect(wrapper.find('form').exists()).toBe(false);
    });

    it('shows history in Tasks and retains only the header language selector in Settings', async () => {
      const f = setup(snapshot(locale));
      f.client.getDownloadHistory = vi.fn().mockResolvedValue([{ downloadId: 'download-1', executionId: 'execution-1', provider: 'qbittorrent', phase: 'succeeded', state: 'completed', progress: 1 }]);
      const wrapper = f.render();
      await flushPromises();
      expect(wrapper.text()).toContain(messages[locale].gatewayConnection);
      await navigate(wrapper, 'tasks');
      expect(wrapper.text()).toContain(messages[locale].downloadHistory);
      expect(wrapper.text()).toContain('download-1');
      expect(wrapper.text()).toContain(messages[locale].historyStatus_succeeded);
      expect(wrapper.text()).toContain(messages[locale].historyStatus_completed);
      f.client.getDownloadHistory = vi.fn().mockRejectedValue('storageError');
      const history = wrapper.get(`[aria-label="${messages[locale].downloadHistory}"]`);
      await history.get('button').trigger('click');
      await flushPromises();
      expect(history.text()).toContain(messages[locale].historyLoadError);
      expect(history.text()).toContain('download-1');
      await navigate(wrapper, 'settings');
      expect(wrapper.find('#settings-language').exists()).toBe(false);
      expect(wrapper.find('.settings-panel .preference-row').exists()).toBe(false);
      expect(wrapper.findAll('select.language-control')).toHaveLength(1);
    });

    it('submits the chosen downloader API key without sending Gateway credentials', async () => {
      const f = setup(snapshot(locale));
      const wrapper = f.render();
      await flushPromises();
      expect(f.client.saveLocale).not.toHaveBeenCalled();
      await navigate(wrapper, 'downloaders');
      const credentials = wrapper.get('.credentials');
      expect(credentials.findAll('label').map((label) => label.text())).toEqual([
        expect.stringContaining(messages[locale].authMode),
        messages[locale].username,
        messages[locale].password,
      ]);
      await wrapper.get('#downloader-host').setValue('192.168.0.73');
      await credentials.get('select').setValue('apiKey');
      expect(credentials.find('[autocomplete="username"]').exists()).toBe(false);
      expect(credentials.text()).toContain(messages[locale].downloaderApiKey);
      await credentials.get('input[type="password"]').setValue('qbt_test-only-key');
      await wrapper.get('form').trigger('submit');
      await flushPromises();
      expect(f.client.testDownloader).toHaveBeenCalledWith({
        provider: 'qbittorrent',
        downloaderUrl: 'http://192.168.0.73:8080',
        username: '',
        authMode: 'apiKey',
        password: { action: 'set', value: 'qbt_test-only-key' },
      });
      expect(f.client.connectGateway).not.toHaveBeenCalled();
      expect(wrapper.find('.credentials').exists()).toBe(false);
    });
    it('clears a draft secret on auth changes and restores the saved mode on cancel', async () => {
      const f = setup({
        ...snapshot(locale, { downloaderConfigured: true, authMode: 'apiKey', username: 'saved-user' }),
        hasPassword: true,
      });
      const wrapper = f.render();
      await flushPromises();
      await navigate(wrapper, 'downloaders');
      await wrapper.get('.card-summary button').trigger('click');
      await wrapper.get('.credentials select').setValue('password');
      expect(wrapper.get('.credentials input[type="password"]').attributes('placeholder')).toBe(
        messages[locale].newSecret
      );
      await wrapper.get('.credentials input[type="password"]').setValue('draft-password');
      await wrapper.get('.credentials select').setValue('apiKey');
      expect((wrapper.get('.credentials input[type="password"]').element as HTMLInputElement).value).toBe('********');
      await wrapper.get('.credentials select').setValue('password');
      await wrapper.get('.section-actions .quiet').trigger('click');
      await wrapper.get('.card-summary button').trigger('click');
      expect((wrapper.get('.credentials select').element as HTMLSelectElement).value).toBe('apiKey');
      await wrapper.get('input[value="transmission"]').setValue();
      expect(wrapper.find('.credentials select').exists()).toBe(false);
      expect((wrapper.get('.credentials input[type="password"]').element as HTMLInputElement).value).toBe('');
    });
    it('keeps drafts across pages and language changes without saving secrets implicitly', async () => {
      const f = setup(snapshot(locale));
      const wrapper = f.render();
      await flushPromises();
      await navigate(wrapper, 'downloaders');
      await wrapper.get('#downloader-host').setValue('nas.home');
      await wrapper.get('.credentials input[type="password"]').setValue('private-draft');
      await navigate(wrapper, 'settings');
      await wrapper.get('.language-control').setValue(locale === 'en-US' ? 'zh-CN' : 'en-US');
      await flushPromises();
      await navigate(wrapper, 'downloaders');
      expect((wrapper.get('#downloader-host').element as HTMLInputElement).value).toBe('nas.home');
      expect((wrapper.get('.credentials input[type="password"]').element as HTMLInputElement).value).toBe(
        'private-draft'
      );
      expect(wrapper.find('.draft-notice').exists()).toBe(true);
      expect(f.client.saveLocale).toHaveBeenCalledTimes(1);
      expect(f.client.testDownloader).not.toHaveBeenCalled();
      expect(f.client.connectGateway).not.toHaveBeenCalled();
    });
    it('marks resource connections as unavailable and exposes no credential submission form', async () => {
      const f = setup(snapshot(locale));
      const wrapper = f.render();
      await flushPromises();
      await navigate(wrapper, 'resource-sites');
      expect(wrapper.text()).toContain(messages[locale].sitesNotAvailableTitle);
      expect(wrapper.findAll('.site-preview')).toHaveLength(3);
      expect(wrapper.find('form').exists()).toBe(false);
    });
    it('allows download configuration after explicit reset confirmation', async () => {
      const f = setup({ ...snapshot(locale, { downloaderConfigured: true }), hasPassword: true });
      const wrapper = f.render();
      await flushPromises();
      await navigate(wrapper, 'downloaders');
      await wrapper.get('.card-summary .summary-actions button:last-child').trigger('click');
      expect(f.client.resetDownloader).not.toHaveBeenCalled();
      await wrapper.get('.reset-confirmation .danger').trigger('click');
      await flushPromises();
      expect(f.client.resetDownloader).toHaveBeenCalledTimes(1);
      expect(wrapper.find('#downloader-host').exists()).toBe(true);
      expect(wrapper.find('.reset-confirmation').exists()).toBe(false);
    });
  });
}

it('retries a failed initial load and never enables secret forms before settings arrive', async () => {
  const f = setup(snapshot('en-US'));
  vi.mocked(f.client.loadSettings).mockRejectedValueOnce('storageError');
  const wrapper = f.render();
  await flushPromises();
  expect(wrapper.find('.load-failure').exists()).toBe(true);
  expect(wrapper.find('form').exists()).toBe(false);
  await wrapper.get('.load-failure button').trigger('click');
  await flushPromises();
  expect(wrapper.find('.load-failure').exists()).toBe(false);
  expect(f.client.loadSettings).toHaveBeenCalledTimes(2);
});
it('marks the last online status as unknown when status refresh fails', async () => {
  const f = setup(snapshot('en-US', { gatewayUrl: 'https://gateway.example', downloaderConfigured: true }));
  f.runtime.service = 'online';
  const wrapper = f.render();
  await flushPromises();
  expect(wrapper.find('.overview-hero.ready').exists()).toBe(true);
  vi.mocked(f.client.getRuntime).mockRejectedValueOnce('networkError');
  await vi.advanceTimersByTimeAsync(2000);
  await flushPromises();
  expect(wrapper.text()).toContain(messages['en-US'].statusReadError);
  expect(wrapper.find('.overview-hero.ready').exists()).toBe(false);
  expect(wrapper.get('.overview-hero h2').text()).toBe(messages['en-US'].statusUnknown);
  expect(wrapper.find('.pill.positive').exists()).toBe(false);
});
it('removes a late host subscription and stops polling after unmount', async () => {
  const f = setup(snapshot('en-US'));
  const stop = vi.fn();
  let finish!: (stop: () => void) => void;
  f.host.onNavigate = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const wrapper = f.render();
  await flushPromises();
  wrapper.unmount();
  finish(stop);
  await flushPromises();
  const calls = vi.mocked(f.client.getRuntime).mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(f.client.getRuntime).toHaveBeenCalledTimes(calls);
});
it('shows host-specific startup controls only when supported and reports failed saves', async () => {
  const f = setup(snapshot('en-US'));
  f.host.setAutostart = vi.fn(async () => {
    throw 'autostartError';
  });
  const wrapper = f.render();
  await flushPromises();
  await navigate(wrapper, 'settings');
  await wrapper.get('#agent-autostart').setValue(false);
  await flushPromises();
  expect(f.host.setAutostart).toHaveBeenCalledWith(false);
  expect(wrapper.text()).toContain(messages['en-US'].autostartError);
  expect((wrapper.get('#agent-autostart').element as HTMLInputElement).checked).toBe(true);
});
