// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { IntegrationPreferences, MovieDownload } from '@movie-hub/contract';
import { setLocale } from '../../i18n';
import MovieDetail from './MovieDetail.vue';

enableAutoUnmount(afterEach);

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

function fixture(primary = 'mteam', sites = ['hdarea', 'mteam']) {
  let preferences: IntegrationPreferences = {
    defaults: { resource: primary, downloader: 'transmission' }, selectedSites: sites, effectiveSites: sites,
    choices: [
      { id: 'mteam', name: 'M-Team', category: 'resource', status: 'configured_valid' },
      { id: 'hdarea', name: 'HDArea', category: 'resource', status: 'configured_valid' },
      { id: 'transmission', name: 'Transmission', category: 'downloader', status: 'configured_valid' },
    ],
  };
  const calls: string[] = [];
  const failures = new Set<string>();
  const posts: unknown[] = [];
  const downloads: MovieDownload[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/integration-preferences/resource-sites')) {
      const selectedSites = JSON.parse(String(init?.body)).sites;
      preferences = { ...preferences, selectedSites, effectiveSites: selectedSites.length ? selectedSites : [primary] };
      return Response.json(preferences);
    }
    if (url.endsWith('/integration-preferences')) return Response.json(preferences);
    if (url.endsWith(
      '/resources'
    )) return Response.json(
      { provider: 'all', checking: false, availability: 'available', incomplete: false }
    );
    if (url.endsWith('/download-providers')) return Response.json({ providers: ['qbittorrent', 'transmission'] });
    if (url.endsWith('/downloads') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      const task: MovieDownload = { id: `task-${body.sourceProvider ?? 'mteam'}`, tmdbId: 603,
        sourceProvider: body.sourceProvider ?? 'mteam', sourceReleaseId: body.sourceReleaseId,
        provider: body.provider, status: 'downloading', progress: 12 };
      downloads.push(task);
      return Response.json(task);
    }
    if (url.endsWith('/downloads')) return Response.json({ items: downloads });
    if (url.endsWith('/releases') || url.endsWith('/releases/refresh')) {
      const site = url.includes('/hdarea/') ? 'hdarea' : 'mteam';
      if (failures.has(
        site
      )) return Response.json(
        { error: { code: 'RESOURCE_SITE_FAILED', details: { reason: 'timeout' } } },
        { status: 504 }
      );
      return Response.json({ site, name: site, supportsDownload: true, availability: 'available', queriedAt: '2026-10-20T00:00:00Z', cached: false,
        releases: [{ id: '42', title: `${site} movie`, seeders: 10, tags: site === 'hdarea' ? ['4K', 'DoVi', 'chinese-subtitles'] : ['中字'], releaseGroup: site === 'mteam' ? 'TURG' : 'BiVerse@ADWeb', publishedAt: '2026-10-05 23:05:14', medium: 'WEB-DL', videoCodec: 'H.265', audioCodec: 'E-AC-3 5.1 Atmos', detailsUrl: `https://example.test/${site}/42` }] }
      );
    }
    return Response.json(
      { tmdbId: 603, title: 'Movie', genres: [], cast: [], directors: [], userStatus: 'interested', userPreference: 'neutral', detailSyncedAt: '2026-10-20T00:00:00Z', stale: false, locale: 'en-US' }
    );
  }));
  return { calls, posts, failures };
}

it.each(['en-US', 'zh-CN'] as const)('groups selected sources, expands the primary, and downloads using the selected default in %s', async (locale) => {
  setLocale(locale);
  const f = fixture();
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  const groups = [...document.body.querySelectorAll<HTMLDetailsElement>('.release-site-group')];
  expect(groups).toHaveLength(2);
  expect(groups[0]?.querySelector('summary')?.textContent).toContain('M-Team');
  expect(groups[0]?.open).toBe(true);
  expect(groups[1]?.open).toBe(false);
  expect(groups[1]?.querySelector('.release-download-button')).not.toBeNull();
  groups[1]!.open = true;
  groups[1]!.dispatchEvent(new Event('toggle'));
  await flushPromises();
  expect(groups[0]?.open).toBe(true);
  expect(groups[1]?.open).toBe(true);
  expect([...groups[1]!.querySelectorAll('.release-tags span')].map((node) => node.textContent)).toEqual([
    '4K', 'DoVi', locale === 'en-US' ? 'Chinese subtitles' : '中字',
  ]
  );
  expect(groups[0]?.querySelector('.release-tags')?.textContent).toContain('中字');
  for (const [index, releaseGroup] of ['TURG', 'BiVerse@ADWeb'].entries()) {
    const text = groups[index]!.textContent!;
    expect(text).toContain(locale === 'en-US' ? 'Release group' : '发布小组');
    expect(text).toContain(releaseGroup);
    for (const value of ['2026-10-05 23:05:14', 'WEB-DL', 'H.265', 'E-AC-3 5.1 Atmos']) expect(text).toContain(value);
  }
  expect(document.body.querySelector('.release-downloader-select')).toBeNull();
  groups[0]!.querySelector<HTMLButtonElement>('.release-download-button')!.click();
  await flushPromises();
  document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .primary')!.click();
  await flushPromises();
  expect(f.posts).toEqual([{ sourceReleaseId: '42', provider: 'transmission', downloaderInstanceId: 'transmission' }]);
  expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  wrapper.unmount();
});

it('opens the first selected site when the primary is outside the selected scope', async () => {
  setLocale('en-US');
  const f = fixture('mteam', ['hdarea']);
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  const groups = document.body.querySelectorAll<HTMLDetailsElement>('.release-site-group');
  expect(groups).toHaveLength(1);
  expect(groups[0]?.open).toBe(true);
  expect(f.calls.some((url) => url.endsWith('/resources/mteam/releases'))).toBe(false);
  wrapper.unmount();
});

it('loads the enabled account sites and removes per-movie site controls', async () => {
  setLocale('en-US');
  const f = fixture();
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  expect(wrapper.find('.resource-site-toggle').exists()).toBe(false);
  expect(f.calls.some((url) => url.endsWith('/integration-preferences'))).toBe(true);
  expect(f.calls.some((url) => url.endsWith('/releases') || url.endsWith('/refresh'))).toBe(false);
});

it('keeps successful releases when another site fails and retries that site independently', async () => {
  setLocale('en-US');
  const f = fixture();
  f.failures.add('hdarea');
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  const groups = [...document.body.querySelectorAll<HTMLDetailsElement>('.release-site-group')];
  expect(groups[0]?.querySelectorAll('.release-card')).toHaveLength(1);
  expect(groups[1]?.querySelector('summary')?.textContent).toContain('Check failed');
  expect(groups[1]?.textContent).toContain('timed out');
  f.failures.clear();
  groups[1]!.open = true;
  groups[1]!.querySelector<HTMLButtonElement>('button')!.click();
  await flushPromises();
  expect(groups[1]?.querySelectorAll('.release-card')).toHaveLength(1);
  expect(f.calls.filter((url) => url.endsWith('/mteam/releases'))).toHaveLength(1);
  expect(
    f.calls.filter((url) => url.endsWith('/hdarea/releases') || url.endsWith('/hdarea/releases/refresh'))
  ).toHaveLength(
    2
  );
  wrapper.unmount();
});

it('ignores an earlier summary that arrives after the user changes the selected sites', async () => {
  setLocale('en-US');
  fixture();
  const baseFetch = globalThis.fetch;
  let resolveOld!: (response: Response) => void;
  let first = true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/resources') && first) {
      first = false;
      return new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
    }
    return baseFetch(input, init);
  })
  );
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  window.dispatchEvent(new Event('integration-preferences-changed'));
  await flushPromises();
  expect(wrapper.find('.resource-status-button').exists()).toBe(true);
  resolveOld(Response.json({ provider: 'all', availability: 'unavailable', checking: false }));
  await flushPromises();
  expect(wrapper.find('.resource-status-button').exists()).toBe(true);
  wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('opens enabled sources through the resource action without site icons in %s', async (locale) => {
  setLocale(locale);
  const f = fixture();
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  expect(wrapper.find('.resource-site-selector').exists()).toBe(false);
  expect(wrapper.find('.resource-site-toggle').exists()).toBe(false);
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  expect(document.body.querySelectorAll('.release-site-group')).toHaveLength(2);
  expect(f.calls.some((url) => url.endsWith('/integration-preferences/resource-sites'))).toBe(false);
});

it.each(['en-US', 'zh-CN'] as const)('queries unavailable resources without opening a dialog in %s', async (locale) => {
  setLocale(locale);
  fixture();
  const baseFetch = globalThis.fetch;
  let queries = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(
      '/resources'
    )) return Response.json(
      { provider: 'all', availability: 'unavailable', checking: false }
    );
    if (url.endsWith('/resources/refresh') && init?.method === 'POST') {
      queries++;
      return Response.json({ provider: 'all', availability: 'available', checking: false });
    }
    return baseFetch(input, init);
  })
  );
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  expect(wrapper.get('.resource-status-button').text()).toBe(locale === 'en-US' ? 'Unavailable' : '暂无资源');
  expect(wrapper.get('.resource-status-button').attributes('title')).toBe(locale === 'en-US' ? 'Query resources' : '查询资源');
  expect(wrapper.find('.resource-refresh-button').exists()).toBe(false);
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  expect(queries).toBe(1);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(wrapper.get('.resource-status-button').text()).toBe(locale === 'en-US' ? 'Available' : '有资源');
  expect(wrapper.get('.resource-status-button').attributes('title')).toBe(locale === 'en-US' ? 'View resources' : '查看资源');
  wrapper.unmount();
});

it('refreshes only the chosen site without toggling its disclosure or replacing the other site', async () => {
  setLocale('en-US');
  const f = fixture();
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  const groups = document.body.querySelectorAll<HTMLDetailsElement>('.release-site-group');
  const otherContents = groups[0]!.querySelector('.release-site-content')?.innerHTML;
  expect(groups[1]!.open).toBe(false);
  groups[1]!.querySelector<HTMLButtonElement>('.release-site-refresh')!.click();
  await flushPromises();
  expect(groups[1]!.open).toBe(false);
  expect(f.calls.filter((url) => url.endsWith('/hdarea/releases/refresh'))).toHaveLength(1);
  expect(f.calls.some((url) => url.endsWith('/mteam/releases/refresh'))).toBe(false);
  expect(f.calls.filter((url) => url.endsWith('/mteam/releases'))).toHaveLength(1);
  expect(groups[0]!.querySelector('.release-site-content')?.innerHTML).toBe(otherContents);
  wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('downloads HDArea independently of an identical M-Team release ID in %s without frontend credentials', async (locale) => {
  setLocale(locale);
  const f = fixture();
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  const groups = document.body.querySelectorAll<HTMLDetailsElement>('.release-site-group');
  groups[1]!.open = true;
  groups[1]!.querySelector<HTMLButtonElement>('.release-download-button')!.click();
  await flushPromises();
  document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .primary')!.click();
  await flushPromises();
  expect(f.posts).toEqual([{ sourceReleaseId: '42', provider: 'transmission', downloaderInstanceId: 'transmission', sourceProvider: 'hdarea' }]);
  expect(groups[1]!.querySelector('[role="status"]')?.textContent).toContain('12%');
  expect(groups[0]!.querySelector('.release-download-progress')).toBeNull();
  groups[0]!.querySelector<HTMLButtonElement>('.release-download-button')!.click();
  await flushPromises();
  document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .primary')!.click();
  await flushPromises();
  expect(f.posts).toHaveLength(2);
  expect(groups[0]!.querySelector('[role="status"]')?.textContent).toContain('12%');
  expect(groups[1]!.querySelector('[role="status"]')?.textContent).toContain('12%');
  expect(JSON.stringify(f.posts)).not.toMatch(/passkey|download\.php|cookie/i);
  wrapper.unmount();
});

it.each(['unchecked', 'unavailable', 'error'] as const)('checks from both resource buttons for %s and disables both while checking', async (state) => {
  setLocale('en-US');
  fixture();
  const base = globalThis.fetch;
  let complete!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/resources')) return Response.json({ provider: 'all', checking: false,
      availability: state === 'error' ? 'unchecked' : state, ...(state === 'error' ? { lastAttemptStatus: 'error' } : {}) });
    if (url.endsWith('/resources/refresh')) return new Promise<Response>((resolve) => {
      complete = resolve;
    });
    return base(input, init);
  }));
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  expect(wrapper.get('.dossier-data > div:last-child').classes()).toContain('dossier-resource');
  const poster = wrapper.get<HTMLButtonElement>('.detail-poster button.poster-resource-badge');
  await poster.trigger('click');
  await flushPromises();
  expect(poster.element.disabled).toBe(true);
  expect(wrapper.get<HTMLButtonElement>('.dossier-resource-button').element.disabled).toBe(true);
  expect(wrapper.get('.dossier-resource-button').text()).toBe('Checking');
  complete(Response.json({ provider: 'all', availability: 'available', checking: false }));
  await flushPromises();
  expect(wrapper.get('.dossier-resource-button').text()).toBe('Available');
  expect(wrapper.get<HTMLButtonElement>('.dossier-resource-button').element.disabled).toBe(false);
  expect(document.body.querySelectorAll('.release-site-group')).toHaveLength(0);
});
