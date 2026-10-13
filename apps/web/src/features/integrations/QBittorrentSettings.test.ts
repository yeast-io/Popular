// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import QBittorrentSettings from './QBittorrentSettings.vue';

describe('qBittorrent settings', () => {
  beforeEach(() => setLocale('en-US'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps deletion with the save actions and requires confirmation', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({
        provider: 'qbittorrent',
        status: 'configured_valid',
        baseUrl: 'http://localhost:8080',
        authMethod: 'api_key',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(QBittorrentSettings);
    await flushPromises();

    expect(wrapper.get('.integration-delete-trigger').element.closest('.integration-actions')).not.toBeNull();
    await wrapper.get('.integration-delete-trigger').trigger('click');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    await wrapper.get('.integration-delete .danger').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    expect(wrapper.text()).toContain('Not configured');
  });
});
