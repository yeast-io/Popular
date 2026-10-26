// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import ResourceNotificationPage from './ResourceNotificationPage.vue';

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(['zh-CN', 'en-US'] as const)(
  'renders mixed media and notification states, opens details and frees a slot in %s',
  async (locale) => {
    setLocale(locale);
    const items = [
      {
        id: 'one',
        tmdbId: 1,
        mediaType: 'movie',
        title: 'Movie',
        status: 'notified',
        createdAt: '2026-10-26T00:00:00Z',
      },
      { id: 'two', tmdbId: 2, mediaType: 'tv', title: 'Show', status: 'pending', createdAt: '2026-10-26T00:00:00Z' },
    ];
    const fetch = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === 'DELETE') {
        items.shift();
        return Response.json({ enabled: false });
      }
      return Response.json({ items, limit: 5, locale });
    });
    vi.stubGlobal('fetch', fetch);
    const wrapper = mount(ResourceNotificationPage);
    await flushPromises();
    expect(wrapper.text()).toContain('2/5');
    expect(wrapper.text()).toContain(locale === 'zh-CN' ? '已通知' : 'Notified');
    expect(wrapper.findAll('.resource-notification-card')).toHaveLength(2);
    expect(wrapper.get('.resource-notification-card').find('[role="status"]').exists()).toBe(true);
    expect(wrapper.get('.resource-notification-card').find('.resource-notification-remove').exists()).toBe(true);
    expect(wrapper.find('time').exists()).toBe(false);
    expect(wrapper.find('.resource-notification-overview').exists()).toBe(false);
    expect(wrapper.get('.resource-notification-metadata').text()).toBe(locale === 'zh-CN' ? '电影' : 'Movies');
    const rows = wrapper.findAll('.resource-notification-entry');
    await rows[0]!.trigger('click');
    await rows[1]!.trigger('click');
    expect(wrapper.emitted('openMovie')![0]).toEqual([1]);
    expect(wrapper.emitted('openTvShow')![0]).toEqual([2]);
    await wrapper.get('.resource-notification-remove').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('1/5');
    expect(fetch.mock.calls.find((call) => call[1]?.method === 'DELETE')![0]).toContain('/movie/1');
    wrapper.unmount();
  }
);
