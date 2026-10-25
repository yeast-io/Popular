// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResourceQueryDialog from './ResourceQueryDialog.vue';
import { setLocale } from '../../i18n';

const qb = '00000000-0000-4000-8000-000000000001';
const tr = '00000000-0000-4000-8000-000000000002';
const mounted: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
});
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
async function setup(options: { remote?: boolean; failed?: boolean; hdarea?: boolean; locale?: 'en-US' | 'zh-CN' } = {}) {
  setLocale(options.locale ?? 'en-US');
  const posts: Record<string, unknown>[] = [];
  let items: Record<string, unknown>[] = options.failed
    ? [{ id: 'old', sourceProvider: 'mteam', sourceReleaseId: '991',
        provider: 'transmission', downloaderInstanceId: tr, downloaderName: 'NAS', status: 'failed', progress: 0 }]
    : [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('integration-preferences')) return Response.json({
      defaults: { resource: 'mteam', downloader: qb }, choices: [], selectedSites: [], effectiveSites: options.hdarea ? ['mteam', 'hdarea'] : ['mteam'],
    });
    if (url.pathname.endsWith('download-providers')) return Response.json({ providers: [
      { downloaderInstanceId: qb, provider: 'qbittorrent', name: 'qBittorrent' },
      { downloaderInstanceId: tr, provider: 'transmission', name: 'NAS' },
    ] });
    if (url.pathname.endsWith('remote-client')) return Response.json({ hasKey: true, devices: options.remote
      ? [{ id: 'agent-a', isAgentOnline: false, isAgentDownloaderOnline: false }]
      : [] });
    if (url.pathname.endsWith('resource-downloads')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        const created = { id: 'created', sourceProvider: body.sourceProvider ?? 'mteam', sourceReleaseId: body.sourceReleaseId,
          ...(body.remoteDeviceId
            ? { executionMode: 'remote', remoteDeviceId: body.remoteDeviceId, pushState: 'accepted', queueExpiresAt: '2026-12-01T00:00:00.000Z', status: 'submitting', progress: 0 }
            : { provider: body.provider, downloaderInstanceId: body.downloaderInstanceId, downloaderName: 'NAS', status: 'downloading', progress: 40 }) };
        items = [created];
        return Response.json(created, { status: 201 });
      }
      return Response.json({ items });
    }
    if (url.pathname.includes('resource-search')) return Response.json({
      releases: [{ id: url.searchParams.get('page') === '2' ? '992' : '991', title: 'Show S01E03-E04', description: 'Hidden subtitle', tags: ['DoVi'] }],
      ...(url.searchParams.get('page') === '2' ? {} : { nextPage: 2 }),
    });
    throw new Error(`Unexpected request ${url.pathname}`);
  }));
  const wrapper = mount(ResourceQueryDialog, { props: { title: 'Show', query: 'Show S01', mediaType: 'tv' }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, posts };
}
async function click(selector: string) {
  document.querySelector<HTMLButtonElement>(selector)!.click();
  await flushPromises();
}

describe('TV resource downloads using the movie controls', () => {
  it.each(['en-US', 'zh-CN'] as const)('selects a downloader and displays progress without assigning episodes in %s', async (locale) => {
    const { posts } = await setup({ locale });
    expect(document.body.textContent).not.toContain('Hidden subtitle');
    await click('.release-download-button');
    expect(document.querySelectorAll('.download-provider-option')).toHaveLength(2);
    await click(`.download-confirmation input[value="${tr}"]`);
    await click('.download-confirmation .primary');
    expect(posts).toEqual([{ query: 'Show S01', page: 1, sourceReleaseId: '991', provider: 'transmission', downloaderInstanceId: tr }]);
    expect(document.querySelector('.release-download-progress')?.textContent).toContain('40%');
    expect(document.querySelector('.release-card')?.classList.contains('is-download-active')).toBe(true);
    expect(document.querySelector('.download-confirmation')).toBeNull();
  });

  it('queues the selected resource through an offline Agent using the same chooser', async () => {
    const { posts } = await setup({ remote: true });
    await click('.release-download-button');
    await click('.download-confirmation input[value="agent:agent-a"]');
    await click('.download-confirmation .primary');
    expect(posts[0]).toEqual({ query: 'Show S01', page: 1, sourceReleaseId: '991', remoteDeviceId: 'agent-a', sourceReleaseTitle: 'Show S01E03-E04' });
    expect(document.querySelector('.release-download-progress')?.textContent).toContain('Queued');
  });

  it('pins a failed resource retry to its original downloader', async () => {
    const { posts } = await setup({ failed: true });
    await click('.release-download-button');
    expect(document.querySelector<HTMLInputElement>(`.download-confirmation input[value="${qb}"]`)?.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>(`.download-confirmation input[value="${tr}"]`)?.checked).toBe(true);
    await click('.download-confirmation .primary');
    expect(posts[0]?.downloaderInstanceId).toBe(tr);
  });

  it('keeps identical resource IDs from different sites separate', async () => {
    const { posts } = await setup({ hdarea: true });
    document.querySelectorAll<HTMLButtonElement>('.release-download-button')[1]!.click();
    await flushPromises();
    await click('.download-confirmation .primary');
    expect(posts[0]?.sourceProvider).toBe('hdarea');
    expect(document.querySelectorAll('.release-site-group')[0]?.querySelector('.release-download-progress')).toBeNull();
  });

  it('submits the source page for a resource appended by load more', async () => {
    const { posts } = await setup();
    await click('.resource-query-more');
    document.querySelectorAll<HTMLButtonElement>('.release-download-button')[1]!.click();
    await flushPromises();
    await click('.download-confirmation .primary');
    expect(posts[0]?.sourceReleaseId).toBe('992');
    expect(posts[0]?.page).toBe(2);
  });
});
