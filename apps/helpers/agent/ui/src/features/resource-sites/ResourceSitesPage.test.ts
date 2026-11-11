// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AgentRoot from '../../AgentRoot.vue';
import messages from '../../locales/messages.json';
import type { AgentClient } from '../../transport/agent-transport.types';
import type { Locale } from '../../settings.types';
import type { ResourceSiteClient, ResourceSiteSnapshot } from './resource-sites.types';

const mounted: VueWrapper[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});
function fixture(locale: Locale, configured = false) {
  const initial: ResourceSiteSnapshot[] = (['mteam', 'hdarea', 'hdwing'] as const).map((site) => ({
    site,
    baseUrl: `https://${site}.example/`,
    enabled: configured,
    status: configured ? 'configured_valid' : 'unconfigured',
    hasCredential: configured,
    hasPasskey: configured && site === 'hdarea',
    requiresPasskey: site === 'hdarea',
    verifiedAt: configured ? 1000 : null,
    lastError: null,
  }));
  const resources: ResourceSiteClient = {
    list: vi.fn(async () => structuredClone(initial)),
    configure: vi.fn<ResourceSiteClient['configure']>(async (input) => ({
      ...initial.find((row) => row.site === input.site)!,
      baseUrl: input.baseUrl,
      status: 'configured_valid',
      hasCredential: true,
      hasPasskey: input.site === 'hdarea',
      enabled: true,
      verifiedAt: 2000,
    })),
    verify: vi.fn<ResourceSiteClient['verify']>(async (site) => ({
      ...initial.find((row) => row.site === site)!,
      status: 'configured_valid',
    })),
    setEnabled: vi.fn(async (site, enabled) => ({ ...initial.find((row) => row.site === site)!, enabled })),
    remove: vi.fn(async () => {}),
  };
  const snapshot = {
    settings: {
      locale,
      gatewayUrl: '',
      provider: 'qbittorrent' as const,
      downloaderUrl: 'http://127.0.0.1:8080',
      username: '',
      authMode: 'password' as const,
      autostart: false,
      gatewayEnabled: false,
      downloaderConfigured: false,
    },
    hasApiKey: false,
    hasPassword: false,
  };
  const client: AgentClient = {
    resourceSites: resources,
    loadSettings: async () => snapshot,
    getRuntime: async () => ({
      service: 'unconfigured',
      downloader: 'unconfigured',
      binding: 'unbound',
      deviceId: null,
      preferenceError: null,
    }),
    connectGateway: async () => snapshot,
    disconnectGateway: async () => {},
    testDownloader: async () => snapshot,
    resetDownloader: async () => snapshot,
    saveLocale: async () => {},
    getQueue: async () => ({ snapshot: null, stale: false, loading: false }),
    setQueuePage: async () => {},
  };
  const wrapper = mount(AgentRoot, { props: { client, host: { version: 'test', openDocumentation: async () => {} } } });
  mounted.push(wrapper);
  const open = async () => {
    await flushPromises();
    await wrapper.get('[data-page="resource-sites"]').trigger('click');
    await flushPromises();
  };
  return { wrapper, resources, open };
}
for (const locale of ['en-US', 'zh-CN'] as const) {
  describe(locale, () => {
    it('uses site-specific credential fields and saves only the selected site credentials', async () => {
      const f = fixture(locale);
      await f.open();
      const card = f.wrapper.get('[data-site="hdarea"]');
      expect(f.wrapper.text()).toContain(messages[locale].localSitesScope);
      expect(card.findAll<HTMLInputElement>('input[type=password]')).toHaveLength(1);
      expect(f.wrapper.get('[data-site=mteam]').text()).toContain(messages[locale].siteApiKey);
      await card.findAll<HTMLInputElement>('input[type=password]')[0]!.setValue('cookie-local-only');
      await card.get('form').trigger('submit');
      await flushPromises();
      expect(f.resources.configure).toHaveBeenCalledWith({
        site: 'hdarea',
        baseUrl: 'https://hdarea.example/',
        credential: { action: 'set', value: 'cookie-local-only' },
      });
      expect(card.find('form').exists()).toBe(false);
      expect(f.wrapper.html()).not.toContain('cookie-local-only');
      expect(f.wrapper.html()).not.toContain('passkey-local-only');
    });
    it('retains drafts across navigation and locale changes without submitting them', async () => {
      const f = fixture(locale);
      await f.open();
      let card = f.wrapper.get('[data-site=mteam]');
      await card.get<HTMLInputElement>('input[type=password]').setValue('local-draft');
      await f.wrapper.get('[data-page=overview]').trigger('click');
      await f.wrapper.get('[data-page=resource-sites]').trigger('click');
      await flushPromises();
      card = f.wrapper.get('[data-site=mteam]');
      expect(card.get<HTMLInputElement>('input[type=password]').element.value).toBe('local-draft');
      await f.wrapper.get('.language-control').setValue(locale === 'en-US' ? 'zh-CN' : 'en-US');
      await flushPromises();
      expect(card.get<HTMLInputElement>('input[type=password]').element.value).toBe('local-draft');
      expect(f.resources.configure).not.toHaveBeenCalled();
    });
    it('requires explicit deletion and supports verify/disable without returning credentials', async () => {
      const f = fixture(locale, true);
      await f.open();
      const card = f.wrapper.get('[data-site=mteam]');
      await card.findAll('.summary-actions button')[1]!.trigger('click');
      await flushPromises();
      expect(f.resources.verify).toHaveBeenCalledWith('mteam');
      await card.findAll('.summary-actions button')[2]!.trigger('click');
      await flushPromises();
      expect(f.resources.setEnabled).toHaveBeenCalledWith('mteam', false);
      await card.get('.local-site-delete button').trigger('click');
      expect(f.resources.remove).not.toHaveBeenCalled();
      expect(card.text()).toContain(messages[locale].siteDeleteConfirm);
      await card.get('.local-site-delete .danger').trigger('click');
      await flushPromises();
      expect(f.resources.remove).toHaveBeenCalledWith('mteam');
      expect(card.find('form').exists()).toBe(true);
    });
  });
}
it('does not reuse masked credentials after changing the endpoint', async () => {
  const f = fixture('en-US', true);
  await f.open();
  const card = f.wrapper.get('[data-site=hdarea]');
  await card.findAll('.summary-actions button')[0]!.trigger('click');
  expect(
    card.findAll<HTMLInputElement>('input[type=password]').every((input) => input.element.value === '********')
  ).toBe(true);
  await card.get('input[type=url]').setValue('https://new.example/');
  expect(card.get('button[type=submit]').attributes('disabled')).toBeDefined();
  await card.get('form').trigger('submit');
  expect(f.resources.configure).not.toHaveBeenCalled();
  await card.findAll<HTMLInputElement>('input[type=password]')[0]!.setValue('new-cookie');
  expect(card.get('button[type=submit]').attributes('disabled')).toBeUndefined();
});
it('offers retry on an initial load failure and marks rejected existing logins invalid', async () => {
  const f = fixture('en-US', true);
  vi.mocked(f.resources.list).mockRejectedValueOnce('networkError');
  await f.open();
  expect(f.wrapper.get('[role=alert]').text()).toContain(messages['en-US'].networkError);
  await f.wrapper.get('.load-failure button').trigger('click');
  await flushPromises();
  const card = f.wrapper.get('[data-site=mteam]');
  vi.mocked(f.resources.verify).mockRejectedValueOnce('siteAuthentication');
  await card.findAll('.summary-actions button')[1]!.trigger('click');
  await flushPromises();
  expect(card.text()).toContain(messages['en-US'].siteInvalid);
  expect(card.get('[role=alert]').text()).toBe(messages['en-US'].siteAuthentication);
});
