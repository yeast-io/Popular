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
    expect(wrapper.get('.resource-notification-quota strong').text()).toBe('2 / 5');
    expect(wrapper.find('.resource-notification-description').exists()).toBe(false);
    expect(wrapper.find('.resource-notification-quota-hint').exists()).toBe(false);
    expect(wrapper.get('.resource-notification-status button').attributes('aria-label')).toBe(locale === 'zh-CN' ? '已通知' : 'Notified');
    expect(wrapper.findAll('.resource-notification-card')).toHaveLength(2);
    expect(wrapper.get('.resource-notification-card').find('.resource-notification-status button').exists()).toBe(true);
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
    expect(wrapper.get('.resource-notification-quota strong').text()).toBe('1 / 5');
    expect(fetch.mock.calls.find((call) => call[1]?.method === 'DELETE')![0]).toContain('/movie/1');
    wrapper.unmount();
  }
);

it.each(['zh-CN', 'en-US'] as const)('highlights a full list including notified titles and clears the warning after removal in %s', async (locale) => {
  setLocale(locale);
  const items = Array.from({ length: 3 }, (_, index) => ({ id: String(index), tmdbId: index + 1,
    mediaType: 'movie', title: `Movie ${index}`, status: 'notified', createdAt: '2026-10-26T00:00:00Z' }));
  vi.stubGlobal('fetch', vi.fn(async (_path: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') {
      items.shift();
      return Response.json({ enabled: false });
    }
    return Response.json({ items, limit: 3, locale });
  }));
  const wrapper = mount(ResourceNotificationPage);
  await flushPromises();
  expect(wrapper.get('.resource-notification-quota strong').text()).toBe('3 / 3');
  expect(wrapper.get('.resource-notification-quota').classes()).toContain('full');
  expect(wrapper.get('.resource-notification-quota').text()).toContain(locale === 'zh-CN' ? '名额已满' : 'Limit reached');
  expect(wrapper.get('.resource-notification-quota-hint').text()).toBe(locale === 'zh-CN' ? '移除一部作品后可添加。' : 'Remove a title to add another.');
  expect(wrapper.get('.resource-notification-quota').attributes('aria-live')).toBe('polite');
  await wrapper.get('.resource-notification-remove').trigger('click');
  await flushPromises();
  expect(wrapper.get('.resource-notification-quota strong').text()).toBe('2 / 3');
  expect(wrapper.get('.resource-notification-quota').classes()).not.toContain('full');
  expect(wrapper.find('.resource-notification-quota-hint').exists()).toBe(false);
  expect(wrapper.get('.resource-notification-quota').attributes('title')).toBe(locale === 'zh-CN' ? '已通知的作品仍占名额，移除后释放。' : 'Notified titles still use a slot. Remove them to free it.');
  wrapper.unmount();
});

it('does not show a misleading empty quota before a successful response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 })));
  const wrapper = mount(ResourceNotificationPage);
  expect(wrapper.find('.resource-notification-quota').exists()).toBe(false);
  await flushPromises();
  expect(wrapper.find('.resource-notification-quota').exists()).toBe(false);
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  wrapper.unmount();
});

it.each(['zh-CN', 'en-US'] as const)('shows the last outcome and next schedule only for unnotified cards in %s', async (locale) => {
  setLocale(locale);
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 7, 14, 0));
  const nextCheckAt = new Date(2026, 10, 7, 17, 30).toISOString();
  const entries = [
    { id: 'new', status: 'pending' },
    { id: 'empty', status: 'pending', lastOutcome: 'no-resources' },
    { id: 'failed', status: 'pending', lastOutcome: 'failed' },
    { id: 'channels', status: 'pending', lastOutcome: 'no-channels' },
    { id: 'notified', status: 'notified', lastOutcome: 'notified' },
  ];
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: entries.map((entry, index) => ({
    ...entry, tmdbId: index + 1, title: entry.id, mediaType: 'movie', createdAt: nextCheckAt, nextCheckAt,
  })), limit: 5, locale })));
  const wrapper = mount(ResourceNotificationPage);
  try {
    await flushPromises();
    const cards = wrapper.findAll('.resource-notification-card');
    const expected = locale === 'zh-CN'
      ? ['尚未检测', '未找到资源', '检测或通知失败', '未配置通知渠道', '已通知']
      : ['Not checked yet', 'No resources found', 'Check or notification failed', 'No notification channel', 'Notified'];
    for (const [index, card] of cards.entries()) {
      expect(card.get('.resource-notification-status button').attributes('aria-label')).toBe(expected[index]);
      expect(card.get('.resource-notification-entry').find('button').exists()).toBe(false);
      if (index === 4) {
        expect(card.find('.resource-notification-next-check').exists()).toBe(false);
        expect(card.get('.resource-notification-status button').classes()).toContain('notified');
      } else {
        expect(card.get('.resource-notification-next-check button').attributes('aria-label')).toContain(locale === 'zh-CN' ? '17:30' : '5:30 PM');
        expect(card.get('.resource-notification-next-check button').attributes('aria-label')).toContain('2026');
        await card.get('.resource-notification-next-check button').trigger('click');
        expect(card.get('[role="tooltip"]').text()).toContain(locale === 'zh-CN' ? '17:30' : '5:30 PM');
        expect(wrapper.emitted('openMovie')).toBeUndefined();
      }
    }
    expect(cards[2]!.get('.resource-notification-status button').classes()).toContain('warning');
    expect(cards[3]!.get('.resource-notification-status button').classes()).toContain('warning');
    expect(wrapper.text()).not.toContain(locale === 'zh-CN' ? '等待检测' : 'Checking');
    expect(wrapper.find('.resource-notification-description').exists()).toBe(false);
  } finally {
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});
