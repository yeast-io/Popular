// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import MovieDetail from './MovieDetail.vue';

describe('Movie Detail live releases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.body.style.overflow = '';
  });

  it('opens returned releases in a modal and closes it with Escape', async () => {
    setLocale('zh-CN');
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/resources/mteam')) {
        return Response.json({ provider: 'mteam', checking: false, availability: 'available', lastAttemptStatus: 'success' });
      }
      if (url.endsWith('/resources/mteam/releases')) {
        return Response.json({
          provider: 'mteam', availability: 'available', queriedAt: '2026-10-13T00:00:00.000Z', cached: false,
          releases: [{
            id: '991', title: 'The.Matrix.1999.2160p.UHD.BluRay', sizeBytes: 2147483648,
            seeders: 12, leechers: 4, publishedAt: '2026-10-13 08:30:00', discount: 'FREE',
            resolution: '4K', medium: 'Remux', videoCodec: 'H.265', audioCodec: 'DTS-HD MA', tags: ['中字'],
          }],
        });
      }
      return Response.json({
        tmdbId: 603, title: '黑客帝国', genres: [], cast: [], directors: [], userStatus: 'interested',
        detailSyncedAt: '2026-10-13T00:00:00.000Z', stale: false, locale: 'zh-CN',
      });
    }));

    const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
    await flushPromises();
    expect(wrapper.get('.poster-resource-badge').text()).toContain('有资源');
    await wrapper.get('.poster-resource-badge').trigger('click');
    await flushPromises();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(wrapper.find('.release-panel').exists()).toBe(false);
    expect(urls).toContain('/api/v1/me/movies/603/resources/mteam/releases');
    expect(dialog?.textContent).toContain('The.Matrix.1999.2160p.UHD.BluRay');
    expect(dialog?.textContent).toContain('2 GB');
    expect(dialog?.textContent).toContain('12');
    expect(dialog?.textContent).toContain('免费');
    expect(dialog?.textContent).toContain('DTS-HD MA');
    expect(dialog?.textContent).toContain('中字');
    expect(document.body.style.overflow).toBe('hidden');

    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    wrapper.unmount();
  });

  it('keeps the list empty and shows an explicit error when the live query fails', async () => {
    setLocale('zh-CN');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/resources/mteam')) {
        return Response.json({ provider: 'mteam', checking: false, availability: 'available', lastAttemptStatus: 'success' });
      }
      if (url.endsWith('/resources/mteam/releases')) {
        return Response.json({ error: { code: 'MTEAM_TIMEOUT', message: 'failed', requestId: 'r1' } }, { status: 504 });
      }
      return Response.json({
        tmdbId: 603, title: '黑客帝国', genres: [], cast: [], directors: [], userStatus: 'interested',
        detailSyncedAt: '2026-10-13T00:00:00.000Z', stale: false, locale: 'zh-CN',
      });
    }));

    const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
    await flushPromises();
    await wrapper.get('.resource-status-button').trigger('click');
    await flushPromises();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe('M-Team 请求超时，请稍后重试。');
    expect(dialog?.querySelectorAll('.release-card')).toHaveLength(0);
    wrapper.unmount();
  });
});
