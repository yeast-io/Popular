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
    setDefault: vi.fn(async (site) => initial.map((row) => ({ ...row, isDefault: row.site === site }))),
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
    it('sets a site default and uses a capsule switch for enablement', async () => {
      const f = fixture(locale, true);
      await f.open();
      const card = f.wrapper.get('[data-site=hdwing]');
      await card.get('input[type=radio]').setValue();
      await flushPromises();
      expect(f.resources.setDefault).toHaveBeenCalledWith('hdwing');
      expect(card.text()).toContain(messages[locale].defaultItem);
      expect(card.get('[role=switch]').attributes('aria-checked')).toBe('true');
      await card.get('[role=switch]').trigger('click');
      await flushPromises();
      expect(f.resources.setEnabled).toHaveBeenCalledWith('hdwing', false);
      expect(card.get('[role=switch]').attributes('aria-checked')).toBe('false');
    });

    it('loads site status on Overview without opening the sites page and retries failures', async () => {
      const f = fixture(locale);
      vi.mocked(f.resources.list).mockRejectedValueOnce('networkError');
      await flushPromises();
      expect(f.wrapper.text()).toContain(messages[locale].networkError);
      const retry = f.wrapper.findAll('button').find((button) => button.text() === messages[locale].retry)!;
      await retry.trigger('click');
      await flushPromises();
      expect(f.resources.list).toHaveBeenCalledTimes(2);
      expect(f.wrapper.text()).toContain('M-Team');
      expect(f.wrapper.text()).toContain('HDArea');
      expect(f.wrapper.text()).toContain('HDWing');
      expect(f.wrapper.findAll('dl .pill').map((pill) => pill.text())).toEqual(Array(3).fill(messages[locale].unconfigured));
    });

    it('uses site-specific credential fields and saves only the selected site credentials', async () => {
      const f = fixture(locale);
      await f.open();
      const card = f.wrapper.get('[data-site="hdarea"]');
      expect(f.wrapper.text()).toContain(messages[locale].localSitesScope);
      expect(card.findAll<HTMLInputElement>('input[type=password]')).toHaveLength(1);
      expect(f.wrapper.get('[data-site=mteam]').text()).toContain(messages[locale].siteApiKey);
      await card.findAll<HTMLInputElement>('input[type=password]')[0]!.setValue('a'.repeat(32));
      await card.get('form').trigger('submit');
      await flushPromises();
      expect(f.resources.configure).toHaveBeenCalledWith({
        site: 'hdarea',
        baseUrl: 'https://hdarea.example/',
        credential: { action: 'set', value: 'a'.repeat(32) },
      });
      expect(card.find('form').exists()).toBe(true);
      expect(card.get('button[type=submit]').text()).toBe(messages[locale].siteVerifySave);
      expect(card.findAll('button:not([role=switch])')).toHaveLength(1);
      expect(card.get<HTMLInputElement>('input[type=password]').element.value).toBe('********');
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
    it('tests and saves existing credentials through the single action and preserves enablement controls', async () => {
      const f = fixture(locale, true);
      await f.open();
      const card = f.wrapper.get('[data-site=mteam]');
      expect(card.findAll('button:not([role=switch])')).toHaveLength(1);
      await card.get('form').trigger('submit');
      await flushPromises();
      expect(f.resources.configure).toHaveBeenCalledWith({ site: 'mteam', baseUrl: 'https://mteam.example/', credential: { action: 'keep' } });
      expect(f.resources.verify).not.toHaveBeenCalled();
      expect(f.resources.remove).not.toHaveBeenCalled();
      expect(card.find('.local-site-delete').exists()).toBe(false);
      expect(card.text()).toContain(messages[locale].siteSaved);
      await card.get('.local-site-controls [role=switch]').trigger('click');
      await flushPromises();
      expect(f.resources.setEnabled).toHaveBeenCalledWith('mteam', false);
    });
  });
}
it('does not reuse masked credentials after changing the endpoint', async () => {
  const f = fixture('en-US', true);
  await f.open();
  const card = f.wrapper.get('[data-site=hdarea]');
  expect(
    card.findAll<HTMLInputElement>('input[type=password]').every((input) => input.element.value === '********')
  ).toBe(true);
  await card.get('#hdarea-base-url').setValue('https://new.example/');
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
  vi.mocked(f.resources.configure).mockRejectedValueOnce('siteAuthentication');
  await card.get('form').trigger('submit');
  await flushPromises();
  expect(card.text()).toContain(messages['en-US'].siteInvalid);
  expect(card.get('[role=alert]').text()).toBe(messages['en-US'].siteAuthentication);
});

it.each(['en-US', 'zh-CN'] as const)('shows only addresses actually used by each site and retains saved configuration after a failed replacement (%s)', async (locale) => {
  const f = fixture(locale, true);
  await f.open();
  const area = f.wrapper.get('[data-site=hdarea]');
  const team = f.wrapper.get('[data-site=mteam]');
  const wing = f.wrapper.get('[data-site=hdwing]');
  expect(area.findAll('input[type=url]')).toHaveLength(2);
  expect(team.findAll('input[type=url]')).toHaveLength(1);
  expect(wing.findAll('input[type=url]')).toHaveLength(1);
  expect(area.get<HTMLInputElement>('#hdarea-api-url').element.value).toBe('https://hdarea.example/api/v1/');
  expect(area.text()).toContain(messages[locale].siteApiAddress);
  expect(area.text()).toContain(messages[locale].siteWebAddress);
  vi.mocked(f.resources.configure).mockRejectedValueOnce('siteAuthentication');
  await area.get('input[type=password]').setValue('b'.repeat(32));
  await area.get('form').trigger('submit');
  await flushPromises();
  expect(area.text()).toContain(messages[locale].siteConfigured);
  expect(area.get<HTMLInputElement>('input[type=password]').element.value).toBe('b'.repeat(32));
  expect(area.get('[role=alert]').text()).toContain(messages[locale].siteAuthentication);
});
