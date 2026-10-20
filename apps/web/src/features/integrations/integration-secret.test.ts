// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import MTeamSettings from './MTeamSettings.vue';
import QBittorrentSettings from './QBittorrentSettings.vue';
import TransmissionSettings from './TransmissionSettings.vue';
import { setLocale } from '../../i18n';
const mask = 'abcdef••••••uvwxyz';
afterEach(() => vi.unstubAllGlobals());
for (const locale of ['zh-CN', 'en-US'] as const) {
  for (const [component, config, selector, field] of [
    [MTeamSettings, { provider: 'mteam', status: 'configured_valid', baseUrl: 'https://api.m-team.cc', apiKeyMasked: mask }, '#mteam-api-key', 'apiKey'],
    [QBittorrentSettings, { provider: 'qbittorrent', status: 'configured_valid', baseUrl: 'http://nas:8080', authMethod: 'api_key', apiKeyMasked: mask }, '#qbittorrent-api-key', 'apiKey'],
    [TransmissionSettings, { provider: 'transmission', status: 'configured_valid', baseUrl: 'http://nas:9091', username: 'user', passwordMasked: mask }, '#transmission-password', 'password'],
  ] as const) {
    it(`${config.provider} displays returned masks and submits only replacement secrets in ${locale}`, async () => {
      setLocale(locale);
      const requests: RequestInit[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PUT') requests.push(init);
        return Response.json(config);
      })
      );
      const wrapper = mount(component); await flushPromises();
      expect((wrapper.get(selector).element as HTMLInputElement).value).toBe(mask);
      expect(wrapper.get(selector).attributes('type')).toBe('text');
      expect(wrapper.text()).toContain('18');
      await wrapper.get('form').trigger('submit'); await flushPromises();
      expect(JSON.parse(String(requests.at(-1)!.body))[field]).toBeUndefined();
      await wrapper.get(selector).setValue('replacement-secret');
      expect(wrapper.get(selector).attributes('type')).toBe('password');
      await wrapper.get('form').trigger('submit'); await flushPromises();
      expect(JSON.parse(String(requests.at(-1)!.body))[field]).toBe('replacement-secret');
      expect((wrapper.get(selector).element as HTMLInputElement).value).toBe(mask);
      expect(wrapper.get(selector).attributes('type')).toBe('text');
      expect(wrapper.text()).toContain('18');
      wrapper.unmount();
    });
  }
}
