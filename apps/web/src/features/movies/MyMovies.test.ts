// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import MyMovies from './MyMovies.vue';

describe('My Movies resource check failures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('distinguishes a first failure from failed refreshes with retained results', async () => {
    setLocale('zh-CN');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      items: [
        {
          tmdbId: 1,
          title: '首次失败',
          userStatus: 'interested',
          resourceCheck: {
            provider: 'mteam', availability: 'unchecked', lastAttemptStatus: 'error',
            lastAttemptAt: '2026-10-13T00:00:00.000Z', lastErrorCode: 'authentication',
          },
        },
        {
          tmdbId: 2,
          title: '此前有资源',
          userStatus: 'interested',
          resourceCheck: {
            provider: 'mteam', availability: 'available', lastAttemptStatus: 'error',
            checkedAt: '2026-10-12T00:00:00.000Z', expiresAt: '2026-10-12T12:00:00.000Z',
            lastAttemptAt: '2026-10-13T00:00:00.000Z', lastErrorCode: 'timeout',
          },
        },
        {
          tmdbId: 3,
          title: '此前无资源',
          userStatus: 'interested',
          resourceCheck: {
            provider: 'mteam', availability: 'unavailable', lastAttemptStatus: 'error',
            checkedAt: '2026-10-12T00:00:00.000Z', expiresAt: '2026-10-12T12:00:00.000Z',
            lastAttemptAt: '2026-10-13T00:00:00.000Z', lastErrorCode: 'rate_limited',
          },
        },
      ],
      pagination: { page: 1, pageSize: 50, total: 3, hasMore: false },
      locale: 'zh-CN',
    })));

    const wrapper = mount(MyMovies);
    await flushPromises();

    const labels = wrapper.findAll('.resource-status').map((node) => node.text());
    expect(labels).toEqual([
      '检查失败',
      '有可下载资源 · 刷新失败',
      '暂无可下载资源 · 刷新失败',
    ]);
    wrapper.unmount();
  });

  it('shows every movie-level state and only labels checkedAt as a successful check', async () => {
    setLocale('zh-CN');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/me/integrations/mteam')) {
        return Response.json({ provider: 'mteam', status: 'configured_valid' });
      }
      return Response.json({
        items: [
          movie(1, { availability: 'available', lastAttemptStatus: 'success', checkedAt: '2026-10-12T00:00:00.000Z' }),
          movie(2, { availability: 'unavailable', lastAttemptStatus: 'success', checkedAt: '2026-10-12T00:00:00.000Z' }),
          movie(3, { availability: 'unchecked' }),
          movie(4, { availability: 'unchecked', checking: true }),
          movie(5, { availability: 'unchecked', lastAttemptStatus: 'error', lastAttemptAt: '2026-10-13T00:00:00.000Z' }),
          movie(6, { availability: 'unmatchable', lastAttemptStatus: 'success', checkedAt: '2026-10-12T00:00:00.000Z' }),
        ],
        pagination: { page: 1, pageSize: 50, total: 6, hasMore: false },
        locale: 'zh-CN',
      });
    }));

    const wrapper = mount(MyMovies);
    await flushPromises();

    expect(wrapper.findAll('.resource-status').map((node) => node.text())).toEqual([
      '有可下载资源', '暂无可下载资源', '尚未检查', '检查中', '检查失败', '无法可靠匹配',
    ]);
    expect(wrapper.findAll('.resource-checked-at')).toHaveLength(3);
    expect(wrapper.text()).not.toContain('2026年10月13日');
    wrapper.unmount();
  });

  it('overrides stale resource results when M-Team is unconfigured and links to settings', async () => {
    setLocale('zh-CN');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/me/integrations/mteam')) {
        return Response.json({ provider: 'mteam', status: 'unconfigured' });
      }
      return Response.json({
        items: [movie(1, {
          availability: 'unavailable', lastAttemptStatus: 'success', checkedAt: '2026-10-12T00:00:00.000Z',
        })],
        pagination: { page: 1, pageSize: 50, total: 1, hasMore: false },
        locale: 'zh-CN',
      });
    }));

    const wrapper = mount(MyMovies);
    await flushPromises();

    expect(wrapper.get('.resource-status').text()).toBe('未配置 M-Team');
    expect(wrapper.text()).not.toContain('暂无可下载资源');
    expect(wrapper.get<HTMLAnchorElement>('.integration-guidance a').attributes('href')).toBe('/settings');
    expect(wrapper.text()).not.toContain('一键同步想看电影');
    wrapper.unmount();
  });
});

function movie(tmdbId: number, resourceCheck: Record<string, unknown>) {
  return {
    tmdbId,
    title: `电影 ${tmdbId}`,
    userStatus: 'interested',
    resourceCheck: { provider: 'mteam', checking: false, ...resourceCheck },
  };
}
