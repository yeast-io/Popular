// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import MovieDetail from './MovieDetail.vue';

describe('Movie Detail live releases', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.body.style.overflow = '';
  });

  it('replaces the poster resource badge with the movie download state', async () => {
    setLocale('zh-CN');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/resources/mteam')) {
        return Response.json({ provider: 'mteam', checking: false, availability: 'available', lastAttemptStatus: 'success' });
      }
      if (url.endsWith('/downloads')) {
        return Response.json({ items: [{
          id: 'd1', tmdbId: 603, sourceProvider: 'mteam', sourceReleaseId: '991', provider: 'qbittorrent',
          status: 'seeding', progress: 100,
        }] });
      }
      return Response.json({
        tmdbId: 603, title: '电影', genres: [], cast: [], directors: [], userStatus: 'interested',
        detailSyncedAt: '2026-10-15T00:00:00.000Z', stale: false, locale: 'zh-CN',
      });
    }));

    const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
    await flushPromises();

    const badge = wrapper.get('.poster-resource-badge');
    expect(badge.text()).toBe('已下载');
    expect(badge.classes()).toContain('is-downloaded');
    expect(badge.element.tagName).toBe('SPAN');
    expect(wrapper.get('.resource-status').text()).toBe('有可下载资源');
    wrapper.unmount();
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
            id: '991', title: 'The.Matrix.1999.2160p.UHD.BluRay', detailsUrl: 'https://kp.m-team.cc/detail/991', sizeBytes: 2147483648,
            seeders: 51, leechers: 4, publishedAt: '2026-10-13 08:30:00', discount: 'FREE',
            resolution: '4K', medium: 'Remux', videoCodec: 'H.265', audioCodec: 'DTS-HD MA', tags: ['中字'],
          }],
        });
      }
      if (url.endsWith('/integrations/qbittorrent')) {
        return Response.json({ provider: 'qbittorrent', status: 'unconfigured' });
      }
      if (url.endsWith('/downloads')) return Response.json({ items: [] });
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
    expect(dialog?.textContent).toContain('51');
    expect(dialog?.textContent).toContain('免费');
    expect(dialog?.textContent).toContain('DTS-HD MA');
    expect(dialog?.textContent).toContain('中字');
    const detailLink = dialog?.querySelector<HTMLAnchorElement>('.release-detail-link');
    expect(detailLink?.href).toBe('https://kp.m-team.cc/detail/991');
    expect(detailLink?.target).toBe('_blank');
    expect(detailLink?.rel).toBe('noopener noreferrer');
    expect(detailLink?.getAttribute('aria-label')).toBe('在 M-Team 打开资源详情');
    const highlightedFacts = [...dialog!.querySelectorAll<HTMLElement>('.release-fact-highlight')];
    expect(highlightedFacts).toHaveLength(2);
    expect(highlightedFacts.map((fact) => fact.textContent)).toEqual([
      expect.stringContaining('做种人数51'),
      expect.stringContaining('下载人数4'),
    ]);
    expect(highlightedFacts[0]?.classList.contains('healthy')).toBe(true);
    expect(highlightedFacts[1]?.classList.contains('healthy')).toBe(false);
    expect(document.body.style.overflow).toBe('hidden');

    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    wrapper.unmount();
  });

  it('requires confirmation, creates one download, and polls only while the release dialog is open', async () => {
    vi.useFakeTimers();
    setLocale('zh-CN');
    let downloadGets = 0;
    let downloadPosts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/resources/mteam')) {
        return Response.json({ provider: 'mteam', checking: false, availability: 'available', lastAttemptStatus: 'success' });
      }
      if (url.endsWith('/resources/mteam/releases')) {
        return Response.json({
          provider: 'mteam', availability: 'available', queriedAt: '2026-10-13T00:00:00.000Z', cached: false,
          releases: [{ id: '991', title: 'Movie.Release', detailsUrl: 'https://kp.m-team.cc/detail/991', sizeBytes: 1000, seeders: 3, resolution: '4K', videoCodec: 'H.265', tags: [] }],
        });
      }
      if (url.endsWith('/integrations/qbittorrent')) {
        return Response.json({ provider: 'qbittorrent', status: 'configured_valid', baseUrl: 'http://nas:8080' });
      }
      if (url.endsWith('/downloads') && init?.method === 'POST') {
        downloadPosts += 1;
        return Response.json({
          id: 'd1', tmdbId: 603, sourceProvider: 'mteam', sourceReleaseId: '991', provider: 'qbittorrent',
          status: 'downloading', progress: 20,
        }, { status: 201 });
      }
      if (url.endsWith('/downloads')) {
        downloadGets += 1;
        return Response.json({ items: downloadPosts ? [{
          id: 'd1', tmdbId: 603, sourceProvider: 'mteam', sourceReleaseId: '991', provider: 'qbittorrent',
          status: 'downloading', progress: 25,
        }] : [] });
      }
      return Response.json({
        tmdbId: 603, title: '电影', genres: [], cast: [], directors: [], userStatus: 'interested',
        detailSyncedAt: '2026-10-13T00:00:00.000Z', stale: false, locale: 'zh-CN',
      });
    }));

    const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
    await flushPromises();
    await wrapper.get('.poster-resource-badge').trigger('click');
    await flushPromises();

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    dialog.querySelector<HTMLButtonElement>('.release-download-button')!.click();
    await flushPromises();
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(downloadPosts).toBe(0);

    document.body.querySelector<HTMLButtonElement>('.download-confirm-actions .primary')!.click();
    await flushPromises();
    expect(downloadPosts).toBe(1);
    expect(dialog.querySelector<HTMLProgressElement>('progress')?.value).toBe(20);
    expect(dialog.querySelector('.release-download-progress')?.classList.contains('downloading')).toBe(true);
    expect(dialog.querySelector('.release-download-button')).toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(downloadGets).toBeGreaterThanOrEqual(2);
    const getsBeforeClose = downloadGets;
    dialog.querySelector<HTMLButtonElement>('.release-panel-heading button')!.click();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(downloadGets).toBe(getsBeforeClose);
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('marks fewer than 20 seeders red while keeping 20 at the default color', async () => {
    setLocale('zh-CN');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/resources/mteam')) {
        return Response.json({ provider: 'mteam', checking: false, availability: 'available', lastAttemptStatus: 'success' });
      }
      if (url.endsWith('/resources/mteam/releases')) {
        return Response.json({
          provider: 'mteam', availability: 'available', queriedAt: '2026-10-14T00:00:00.000Z', cached: false,
          releases: [
            { id: '19', title: 'Low.Seeders', detailsUrl: 'https://kp.m-team.cc/detail/19', seeders: 19, tags: [] },
            { id: '20', title: 'Boundary.Seeders', detailsUrl: 'https://kp.m-team.cc/detail/20', seeders: 20, tags: [] },
          ],
        });
      }
      if (url.endsWith('/integrations/qbittorrent')) {
        return Response.json({ provider: 'qbittorrent', status: 'unconfigured' });
      }
      if (url.endsWith('/downloads')) return Response.json({ items: [] });
      return Response.json({
        tmdbId: 603, title: '电影', genres: [], cast: [], directors: [], userStatus: 'interested',
        detailSyncedAt: '2026-10-14T00:00:00.000Z', stale: false, locale: 'zh-CN',
      });
    }));

    const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
    await flushPromises();
    await wrapper.get('.poster-resource-badge').trigger('click');
    await flushPromises();

    const cards = document.body.querySelectorAll<HTMLElement>('.release-card');
    expect(cards[0]?.querySelector('.release-fact-highlight')?.classList.contains('low-seeders')).toBe(true);
    expect(cards[1]?.querySelector('.release-fact-highlight')?.classList.contains('low-seeders')).toBe(false);
    wrapper.unmount();
  });

  it('stably places every release with a download record before releases without one', async () => {
    setLocale('zh-CN');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/resources/mteam')) {
        return Response.json({ provider: 'mteam', checking: false, availability: 'available', lastAttemptStatus: 'success' });
      }
      if (url.endsWith('/resources/mteam/releases')) {
        return Response.json({
          provider: 'mteam', availability: 'available', queriedAt: '2026-10-14T00:00:00.000Z', cached: false,
          releases: [
            { id: 'plain-a', title: 'Plain A', detailsUrl: 'https://kp.m-team.cc/detail/plain-a', seeders: 30, tags: [] },
            { id: 'failed', title: 'Failed Download', detailsUrl: 'https://kp.m-team.cc/detail/failed', seeders: 30, tags: [] },
            { id: 'plain-b', title: 'Plain B', detailsUrl: 'https://kp.m-team.cc/detail/plain-b', seeders: 30, tags: [] },
            { id: 'missing', title: 'Missing Download', detailsUrl: 'https://kp.m-team.cc/detail/missing', seeders: 30, tags: [] },
          ],
        });
      }
      if (url.endsWith('/integrations/qbittorrent')) {
        return Response.json({ provider: 'qbittorrent', status: 'configured_valid', baseUrl: 'http://nas:8080' });
      }
      if (url.endsWith('/downloads')) {
        return Response.json({ items: [
          { id: 'd-failed', tmdbId: 603, sourceProvider: 'mteam', sourceReleaseId: 'failed', provider: 'qbittorrent', status: 'failed', progress: 0 },
          { id: 'd-missing', tmdbId: 603, sourceProvider: 'mteam', sourceReleaseId: 'missing', provider: 'qbittorrent', status: 'missing', progress: 0 },
        ] });
      }
      return Response.json({
        tmdbId: 603, title: '电影', genres: [], cast: [], directors: [], userStatus: 'interested',
        detailSyncedAt: '2026-10-14T00:00:00.000Z', stale: false, locale: 'zh-CN',
      });
    }));

    const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
    await flushPromises();
    await wrapper.get('.poster-resource-badge').trigger('click');
    await flushPromises();

    const titles = [...document.body.querySelectorAll<HTMLElement>('.release-card h3')].map((title) => title.textContent);
    expect(titles).toEqual(['Failed Download', 'Missing Download', 'Plain A', 'Plain B']);
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
