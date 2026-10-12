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
});
