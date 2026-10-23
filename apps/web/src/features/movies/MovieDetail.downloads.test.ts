// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadProvider, DownloaderChoice, DownloadSource, MovieDownload, RemoteClientDevice } from '@movie-hub/contract';
import { setLocale } from '../../i18n';
import MovieDetail from './MovieDetail.vue';

enableAutoUnmount(afterEach);

async function setup(
  providers: DownloadProvider[],
  options: {
    locale?: 'en-US' | 'zh-CN';
    progress?: number;
    fail?: boolean;
    defaultProvider?: DownloadProvider;
    providersFail?: boolean;
    retry?: DownloadProvider;
    status?: MovieDownload['status'];
    extraRelease?: boolean;
    hdarea?: boolean;
    downloaderChoices?: DownloaderChoice[];
    postResponse?: Promise<Response>;
    remoteDevices?: RemoteClientDevice[];
    existingRemoteDeviceId?: string;
  } = {}
) {
  setLocale(options.locale ?? 'en-US');
  let downloadGets = 0;
  const posts: { sourceReleaseId: string; provider: DownloadProvider; downloaderInstanceId: string }[] = [];
  const existing
    = options.retry || options.status
      ? [
          {
            id: 'old',
            tmdbId: 603,
            sourceProvider: 'mteam',
            sourceReleaseId: '991',
            provider: options.retry ?? 'transmission',
            status: options.status ?? 'failed',
            progress: options.progress ?? 0,
            ...(options.existingRemoteDeviceId
              ? { executionMode: 'remote', remoteDeviceId: options.existingRemoteDeviceId, pushState: 'succeeded' }
              : {}),
          },
        ]
      : [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/me/remote-client')) return Response.json({ hasKey: true, devices: options.remoteDevices ?? [] });
      if (url.endsWith('/me/integration-preferences')) return Response.json({
        defaults: { resource: 'mteam', ...(options.defaultProvider ? { downloader: options.defaultProvider } : {}) }, selectedSites: [], effectiveSites: options.hdarea ? ['mteam', 'hdarea'] : ['mteam'],
        choices: [{ id: 'mteam', name: 'M-Team', category: 'resource', status: 'configured_valid' }],
      }
      );

      if (url.endsWith('/download-providers'))
        return options.providersFail ? new Response(null, { status: 503 }) : Response.json({ providers: options.downloaderChoices ?? providers });
      if (url.endsWith('/resources/mteam/releases') || url.endsWith('/resources/hdarea/releases'))
        return Response.json({
          provider: url.includes('/hdarea/') ? 'hdarea' : 'mteam',
          supportsDownload: true,
          availability: 'available',
          queriedAt: '2026-10-17T00:00:00Z',
          cached: false,
          releases: [
            ...(options.extraRelease
              ? [{ id: '990', title: 'Earlier.Release', detailsUrl: 'https://mteam.test/990', seeders: 20, tags: [] }]
              : []),
            { id: '991', title: 'Movie.Release', detailsUrl: 'https://mteam.test/991', seeders: 20, tags: [] },
          ],
        }
        );
      if (url.endsWith('/resources'))
        return Response.json({ provider: 'mteam', checking: false, availability: 'available' });
      if (url.endsWith('/downloads') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (options.postResponse) return options.postResponse;
        return options.fail
          ? Response.json({ error: { code: 'TRANSMISSION_UNREACHABLE' } }, { status: 503 })
          : Response.json(
              {
                id: 'new',
                tmdbId: 603,
                sourceProvider: body.sourceProvider ?? 'mteam',
                sourceReleaseId: '991',
                provider: body.provider ?? 'qbittorrent',
                ...(body.remoteDeviceId
                  ? { executionMode: 'remote', remoteDeviceId: body.remoteDeviceId,
                      pushState: 'accepted', queueExpiresAt: '2026-10-30T00:00:00Z' }
                  : {}),
                status: 'downloading',
                progress: 35,
              },
              { status: 201 }
            );
      }
      if (url.endsWith('/downloads')) {
        downloadGets++;
        return Response.json({ items: existing });
      }
      return Response.json({
        tmdbId: 603,
        title: 'Movie',
        genres: [],
        cast: [],
        directors: [],
        userStatus: 'interested',
        detailSyncedAt: '2026-10-17T00:00:00Z',
        stale: false,
        locale: 'en-US',
      }
      );
    })
  );
  const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: true } });
  await flushPromises();
  await wrapper.get('.resource-status-button').trigger('click');
  await flushPromises();
  const clickDownload = async (confirmSelected = true) => {
    document.body.querySelector<HTMLButtonElement>('.release-download-button')!.click();
    await flushPromises();
    if (confirmSelected && document.body.querySelector('[role=alertdialog] input:checked')) {
      document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .primary')!.click();
      await flushPromises();
    }
  };
  return { wrapper, posts, clickDownload, downloadGets: () => downloadGets,
    setDownloadStatus: (status: MovieDownload['status']) => { existing[0]!.status = status; } };
}

describe('download provider selection', () => {
  it('shows saved downloader names, hides the group caption, and gives the icon-only download button a label', async () => {
    const f = await setup(['qbittorrent', 'transmission'], {
      downloaderChoices: [
        { downloaderInstanceId: '00000000-0000-4000-8000-000000000001', provider: 'qbittorrent', name: 'Home NAS' },
        { downloaderInstanceId: '00000000-0000-4000-8000-000000000002', provider: 'transmission', name: 'Seedbox' },
      ],
    });
    expect(document.body.querySelector('.release-downloader-select')).toBeNull();
    await f.clickDownload(false);
    expect(f.posts).toEqual([]);
    const choices = [...document.body.querySelectorAll<HTMLElement>('.download-provider-option')];
    expect(choices.map((choice) => choice.textContent?.trim())).toEqual(['Home NAS', 'Seedbox']);
    expect(choices.every((choice) => choice.querySelector('img') !== null)).toBe(true);
    expect(document.body.querySelector('[role=alertdialog] fieldset')?.getAttribute('aria-label')).toBe('Downloader');
    const button = document.body.querySelector<HTMLButtonElement>('.release-download-button')!;
    expect(button.textContent?.trim()).toBe('');
    expect(button.getAttribute('aria-label')).toBe('Download');
    expect(button.querySelector('svg')).not.toBeNull();
    f.wrapper.unmount();
  });

  it('uses downloader types when saved names are unavailable', async () => {
    const f = await setup(['qbittorrent', 'transmission']);
    expect(document.body.querySelector('.release-downloader-select')).toBeNull();
    await f.clickDownload(false);
    expect(f.posts).toEqual([]);
    const choices = [...document.body.querySelectorAll<HTMLElement>('.download-provider-option')];
    expect(choices.map((choice) => choice.textContent?.trim())).toEqual(['qBittorrent', 'Transmission']);
    f.wrapper.unmount();
  });

  it('moves the submitted release to the top and scrolls the list before the server responds', async () => {
    let respond!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const f = await setup(['transmission'], { extraRelease: true, postResponse });
    const panel = document.body.querySelector<HTMLElement>('.release-panel-content')!;
    panel.scrollTop = 500;
    const scrollTo = vi.spyOn(panel, 'scrollTo').mockImplementation(() => {});
    document.body.querySelector<HTMLButtonElement>('.release-card:last-child .release-download-button')!.click();
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .primary')!.click();
    await flushPromises();
    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'smooth' });
    const first = panel.querySelector<HTMLElement>('.release-card')!;
    expect(first.querySelector('h3')?.textContent).toBe('Movie.Release');
    expect(first.classList.contains('is-download-active')).toBe(true);
    expect(first.querySelector('[role="status"]')?.textContent).toContain('Submitting');
    expect(first.querySelector('progress')?.hasAttribute('value')).toBe(false);
    respond(Response.json({ error: { code: 'TRANSMISSION_UNREACHABLE' } }, { status: 503 }));
    await flushPromises();
    expect(first.classList.contains('is-download-active')).toBe(false);
    expect(first.classList.contains('is-download-failed')).toBe(true);
    f.wrapper.unmount();
  });

  it.each([
    ['mteam', 'en-US'], ['hdarea', 'en-US'], ['mteam', 'zh-CN'], ['hdarea', 'zh-CN'],
  ] as const)('scrolls only the panel to the reordered %s card in %s', async (site: DownloadSource, locale) => {
    let respond!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const f = await setup(['transmission'], { extraRelease: true, hdarea: true, locale, postResponse });
    const panel = document.body.querySelector<HTMLElement>('.release-panel-content')!;
    const card = panel.querySelector<HTMLElement>(`[data-release-key="${site}:991"]`)!;
    const group = card.closest('details')!;
    group.open = true;
    group.dispatchEvent(new Event('toggle'));
    await flushPromises();
    panel.scrollTop = 500;
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => {
      // Read its position after Vue has moved the clicked card to the site's first row.
      expect(group.querySelector('.release-card')).toBe(card);
      return { top: site === 'hdarea' ? 330 : 130 } as DOMRect;
    });
    const scrollTo = vi.spyOn(panel, 'scrollTo').mockImplementation(() => {});
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: locale === 'zh-CN' } as MediaQueryList);
    card.querySelector<HTMLButtonElement>('.release-download-button')!.click();
    await flushPromises();
    document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .primary')!.click();
    await flushPromises();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
      top: site === 'hdarea' ? 730 : 530,
      behavior: locale === 'zh-CN' ? 'instant' : 'smooth',
    }
    );
    expect(card.querySelector('[role="status"]')?.textContent).toContain(locale === 'zh-CN' ? '正在提交' : 'Submitting');
    respond(Response.json({
      id: 'new', tmdbId: 603, sourceProvider: site, sourceReleaseId: '991',
      provider: 'transmission', status: 'downloading', progress: 35,
    }, { status: 201 }
    )
    );
    await flushPromises();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    f.wrapper.unmount();
  });

  it.each([
    ['submitting', 'is-download-active'],
    ['downloading', 'is-download-active'],
    ['completed', 'is-download-complete'],
    ['seeding', 'is-download-complete'],
    ['paused', 'is-download-paused'],
    ['failed', 'is-download-failed'],
  ] as const
  )('shows the correct card highlight for %s', async (status, expectedClass) => {
    const f = await setup(['transmission'], { status });
    const card = document.body.querySelector<HTMLElement>('.release-card')!;
    expect(card.classList.contains(expectedClass)).toBe(true);
    if (status === 'completed' || status === 'seeding')
      expect(card.classList.contains('is-download-active')).toBe(false);
    f.wrapper.unmount();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.body.style.overflow = '';
  });

  it.each(['qbittorrent', 'transmission'] as const)(
    'opens the picker before submitting when only %s is configured',
    async (provider) => {
      const f = await setup([provider]);
      await f.clickDownload(false);
      expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
      expect(f.posts).toEqual([]);
      document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .primary')!.click();
      await flushPromises();
      expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
      expect(f.posts).toEqual([{ sourceReleaseId: '991', provider, downloaderInstanceId: provider }]);
      expect(document.body.querySelector('.release-download-progress')?.textContent).toContain(
        provider === 'transmission' ? 'Transmission' : 'qBittorrent'
      );
      f.wrapper.unmount();
    });

  it('waits for an explicit choice with multiple downloaders, then submits only to the selected one', async () => {
    const f = await setup(['qbittorrent', 'transmission']);
    await f.clickDownload();
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog).not.toBeNull();
    expect(f.posts).toEqual([]);
    expect(dialog.querySelector<HTMLButtonElement>('.primary')?.disabled).toBe(true);
    const radio = dialog.querySelector<HTMLInputElement>('input[value="transmission"]')!;
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    dialog.querySelector<HTMLButtonElement>('.primary')!.click();
    await flushPromises();
    expect(f.posts).toEqual([{ sourceReleaseId: '991', provider: 'transmission', downloaderInstanceId: 'transmission' }]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    f.wrapper.unmount();
  });

  it('cancels without creating a task and keeps keyboard focus inside the picker', async () => {
    const f = await setup(['qbittorrent', 'transmission']);
    await f.clickDownload();
    let dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
    const cancel = dialog.querySelector<HTMLButtonElement>('.secondary')!;
    cancel.focus();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(dialog.querySelector('input'));
    cancel.click();
    await flushPromises();
    expect(f.posts).toEqual([]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    await f.clickDownload();
    dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.body.querySelector('.release-panel')).not.toBeNull();
    expect(f.posts).toEqual([]);
    f.wrapper.unmount();
  });

  it('prompts for configuration with no downloader and reports configuration lookup failures', async () => {
    const empty = await setup([]);
    expect(document.body.querySelector<HTMLButtonElement>('.release-download-button')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Configure a downloader in Settings first');
    expect(empty.posts).toEqual([]);
    empty.wrapper.unmount();
    const failed = await setup([], { providersFail: true });
    expect(document.body.textContent).toContain('Could not load downloaders');
    expect(failed.posts).toEqual([]);
    failed.wrapper.unmount();
  });

  it('reports submission errors and never sends to the other downloader', async () => {
    const f = await setup(['transmission'], { fail: true });
    await f.clickDownload();
    expect(f.posts).toEqual([{ sourceReleaseId: '991', provider: 'transmission', downloaderInstanceId: 'transmission' }]);
    expect(document.body.querySelector('.release-card [role="alert"]')?.textContent).toContain(
      'Transmission could not be reached'
    );
    f.wrapper.unmount();
  });

  it('keeps retries on their original downloader', async () => {
    const f = await setup(['qbittorrent', 'transmission'], { retry: 'transmission' });
    await f.clickDownload();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(f.posts).toEqual([{ sourceReleaseId: '991', provider: 'transmission', downloaderInstanceId: 'transmission' }]);
    f.wrapper.unmount();
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  it(`stops polling a deleted Agent task and permits public Transmission after the old Agent is unbound (${locale})`, async () => {
    vi.useFakeTimers();
    const f = await setup(['transmission'], { locale, status: 'missing', existingRemoteDeviceId: 'old-agent',
      remoteDevices: [] });
    const gets = f.downloadGets();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(f.downloadGets()).toBe(gets);
    await f.clickDownload();
    expect(f.posts).toEqual([{ sourceReleaseId: '991', provider: 'transmission', downloaderInstanceId: 'transmission' }]);
    f.wrapper.unmount();
  });
  it.each(['failed'] as const)(`keeps observing an accepted Agent task after %s and displays recovery (${locale})`, async (status) => {
    vi.useFakeTimers();
    const f = await setup([], { locale, status, existingRemoteDeviceId: 'device-a',
      remoteDevices: [{ id: 'device-a', authVersion: 1, deviceVersion: 1,
        boundAt: '2026-10-21T00:00:00Z', isAgentOnline: true, isAgentDownloaderOnline: true }] });
    const getsBeforeRecovery = f.downloadGets();
    f.setDownloadStatus('paused');
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(f.downloadGets()).toBeGreaterThan(getsBeforeRecovery);
    expect(document.body.querySelector('.release-download-progress')?.textContent).toContain(
      locale === 'zh-CN' ? '已暂停' : 'Paused');
    expect(document.body.querySelector('.release-card')?.classList.contains('is-download-failed')).toBe(false);
    expect(f.posts).toEqual([]);
    document.body.querySelector<HTMLButtonElement>('.release-panel-heading button')!.click();
    const getsBeforeClose = f.downloadGets();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(f.downloadGets()).toBe(getsBeforeClose);
    f.wrapper.unmount();
  });
}

it.each(['en-US', 'zh-CN'] as const)('shows a neutral missing task without stale progress and permits explicit redownload in %s', async (locale) => {
  const f = await setup(['qbittorrent'], { locale, retry: 'qbittorrent', status: 'missing', progress: 2 });
  const card = document.body.querySelector<HTMLElement>('.release-card')!;
  const status = card.querySelector<HTMLElement>('[role="status"]')!;
  expect(card.classList.contains('is-download-failed')).toBe(false);
  expect(card.classList.contains('is-download-active')).toBe(false);
  expect(status.classList.contains('missing')).toBe(true);
  expect(status.textContent).toContain(locale === 'zh-CN' ? '下载器中不存在该任务' : 'Task is missing from the downloader');
  expect(status.textContent).not.toContain('2%');
  expect(status.querySelector('progress')).toBeNull();
  expect(card.querySelector('.release-download-button')?.textContent?.trim()).toBe('');
  expect(card.querySelector('.release-download-button')?.getAttribute('aria-label')).toBe(
    locale === 'zh-CN' ? '重新下载' : 'Download again'
  );
  expect(f.posts).toEqual([]);
  await f.clickDownload();
  expect(f.posts).toEqual([{ sourceReleaseId: '991', provider: 'qbittorrent', downloaderInstanceId: 'qbittorrent' }]);
  f.wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('offers an offline bound Agent without a local downloader and explains the queue before pushing (%s)', async (locale) => {
  const f = await setup([], { locale, remoteDevices: [{ id: 'device-a', authVersion: 1, deviceVersion: 1,
    boundAt: '2026-10-21T00:00:00Z', isAgentOnline: false, isAgentDownloaderOnline: false }] });
  await f.clickDownload(false);
  const dialog = document.body.querySelector<HTMLElement>('[role=alertdialog]')!;
  expect(dialog.querySelector('.download-provider-option-agent')?.getAttribute('title')).toContain('device-a');
  expect(dialog.textContent).not.toContain('device-a');
  expect(dialog.querySelector('.download-provider-divider')).toBeNull();
  expect(dialog.textContent).toContain(locale === 'zh-CN' ? '保留 7 天' : '7 days');
  expect(dialog.querySelector('.download-agent-status')?.getAttribute('aria-label')).toBe(locale === 'zh-CN' ? '离线或不可用' : 'Offline or unavailable');
  expect(dialog.querySelector('.download-agent-status')?.classList.contains('is-online')).toBe(false);
  expect(f.posts).toEqual([]);
  dialog.querySelector<HTMLButtonElement>('.primary')!.click();
  await flushPromises();
  expect(f.posts).toEqual([{ sourceReleaseId: '991', remoteDeviceId: 'device-a', sourceReleaseTitle: 'Movie.Release' }]);
  expect(document.body.textContent).toContain(locale === 'zh-CN' ? '等待推送至下载助手' : 'Queued for Agent');
  expect(document.body.textContent).toContain(locale === 'zh-CN' ? '到期并自动删除' : 'expires and is deleted');
  f.wrapper.unmount();
});

it.each(['en-US', 'zh-CN'] as const)('pushes a missing task back to its original Agent and replaces the missing status (%s)', async (locale) => {
  const f = await setup([], { locale, status: 'missing', progress: 50, existingRemoteDeviceId: 'device-a',
    remoteDevices: [{ id: 'device-a', authVersion: 1, deviceVersion: 1,
      boundAt: '2026-10-21T00:00:00Z', isAgentOnline: true, isAgentDownloaderOnline: true }] });
  const card = document.body.querySelector<HTMLElement>('.release-card')!;
  expect(card.querySelector('[role=status]')?.textContent).toContain(
    locale === 'zh-CN' ? '下载器中不存在该任务' : 'Task is missing from the downloader');
  expect(card.querySelector('progress')).toBeNull();
  await f.clickDownload(false);
  const selected = document.body.querySelector<HTMLInputElement>('[role=alertdialog] input:checked')!;
  expect(selected.value).toBe('agent:device-a');
  document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .primary')!.click();
  await flushPromises();
  expect(f.posts).toEqual([{ sourceReleaseId: '991', remoteDeviceId: 'device-a', sourceReleaseTitle: 'Movie.Release' }]);
  expect(card.querySelector('[role=status]')?.textContent).toContain(
    locale === 'zh-CN' ? '等待推送至下载助手' : 'Queued for Agent');
  expect(card.querySelector('[role=status]')?.textContent).not.toContain(
    locale === 'zh-CN' ? '下载器中不存在该任务' : 'Task is missing from the downloader');
  expect(card.querySelector('.release-download-button')).toBeNull();
  f.wrapper.unmount();
});
