// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import type { IntegrationPreferences, MovieDownload } from '@movie-hub/contract';
import { setLocale } from '../../i18n';
import MovieDetail from './MovieDetail.vue';

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
  expect(document.body.querySelector('.release-downloader-option.is-selected')?.getAttribute('aria-label')).toBe(
    'Transmission'
  );
  expect(document.body.querySelector('.release-downloader-option.is-selected img')?.getAttribute('src')).toBeTruthy();
  groups[0]!.querySelector<HTMLButtonElement>('.release-download-button')!.click();
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

it('changing the account selection refreshes status without issuing resource searches', async () => {
  setLocale('en-US');
  const f = fixture();
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  const mteam = wrapper.findAll('.resource-site-toggle').find((node) => node.attributes('aria-pressed') === 'true');
  await mteam!.trigger('click');
  await flushPromises();
  expect(wrapper.findAll('.resource-site-toggle')[0]!.classes()).not.toContain('is-selected');
  expect(f.calls.some((url) => url.endsWith('/integration-preferences/resource-sites'))).toBe(true);
  expect(f.calls.some((url) => url.endsWith('/releases') || url.endsWith('/refresh'))).toBe(false);
  wrapper.unmount();
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
  await wrapper.findAll('.resource-site-toggle')[0]!.trigger('click');
  await flushPromises();
  expect(wrapper.find('.resource-status-button').exists()).toBe(true);
  resolveOld(Response.json({ provider: 'all', availability: 'unavailable', checking: false }));
  await flushPromises();
  expect(wrapper.find('.resource-status-button').exists()).toBe(true);
  wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('keeps icon clicks for selection and opens resources through the separate action in %s', async (locale) => {
  setLocale(locale);
  const f = fixture();
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/resources')) return Response.json({
      provider: 'all', checking: false, availability: 'available',
      sources: [
        { provider: 'mteam', checking: false, availability: 'available', checkedAt: '2026-10-20T00:00:00Z' },
        { provider: 'hdarea', checking: false, availability: 'unavailable' },
      ],
    }
    );
    return baseFetch(input, init);
  })
  );
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  const tiles = wrapper.findAll('.resource-site-tile');
  const mteam = tiles.find((tile) => tile.text().includes('M-Team'))!;
  const hdarea = tiles.find((tile) => tile.text().includes('HDArea'))!;
  expect(mteam.get('button').attributes('aria-pressed')).toBe('true');
  expect(hdarea.get<HTMLButtonElement>('button').element.disabled).toBe(false);
  expect(wrapper.find('.resource-site-fill').exists()).toBe(false);
  expect(wrapper.find('.resource-site-name').exists()).toBe(false);
  expect(wrapper.find('input[type=checkbox]').exists()).toBe(false);
  expect(mteam.attributes('title')).toContain(locale === 'en-US' ? 'Resources available' : '有资源');
  expect(mteam.attributes('title')).toContain(locale === 'en-US' ? 'Checked:' : '查询时间：');
  await mteam.get('button').trigger('click');
  await flushPromises();
  expect(document.body.querySelectorAll('.release-site-group')).toHaveLength(0);
  expect(f.calls.some((url) => url.endsWith('/releases'))).toBe(false);
  expect(f.calls.some((url) => url.endsWith('/integration-preferences/resource-sites'))).toBe(true);
  expect(mteam.get('button').attributes('aria-pressed')).toBe('false');
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  expect(document.body.querySelectorAll('.release-site-group')).toHaveLength(1);
  expect(document.body.querySelector('.release-site-group summary')?.textContent).toContain('HDArea');
  wrapper.unmount();
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
  expect(wrapper.get('.resource-status-button').text()).toBe(locale === 'en-US' ? 'Query resources' : '查询资源');
  expect(wrapper.find('.resource-refresh-button').exists()).toBe(false);
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  expect(queries).toBe(1);
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(wrapper.get('.resource-status-button').text()).toBe(locale === 'en-US' ? 'View resources' : '查看资源');
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
  expect(f.posts).toEqual([{ sourceReleaseId: '42', provider: 'transmission', downloaderInstanceId: 'transmission', sourceProvider: 'hdarea' }]);
  expect(groups[1]!.querySelector('[role="status"]')?.textContent).toContain('12%');
  expect(groups[0]!.querySelector('.release-download-progress')).toBeNull();
  groups[0]!.querySelector<HTMLButtonElement>('.release-download-button')!.click();
  await flushPromises();
  expect(f.posts).toHaveLength(2);
  expect(groups[0]!.querySelector('[role="status"]')?.textContent).toContain('12%');
  expect(groups[1]!.querySelector('[role="status"]')?.textContent).toContain('12%');
  expect(JSON.stringify(f.posts)).not.toMatch(/passkey|download\.php|cookie/i);
  wrapper.unmount();
});
