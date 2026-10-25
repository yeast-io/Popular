// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResourceQueryDialog from './ResourceQueryDialog.vue';
import { setLocale } from '../../i18n';

const preferences = {
  defaults: { resource: 'mteam' }, selectedSites: ['mteam', 'hdarea'], effectiveSites: ['mteam', 'hdarea'],
  choices: [{ id: 'mteam', name: 'M-Team', category: 'resource', status: 'configured_valid' },
    { id: 'hdarea', name: 'HDArea', category: 'resource', status: 'configured_valid' }],
};
const mounted: ReturnType<typeof mount>[] = [];
const render = () => {
  const wrapper = mount(ResourceQueryDialog, {
    props: { title: 'MobLand · Season 1', query: 'MobLand S01', mediaType: 'tv' }, attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
};
const text = () => document.querySelector('dialog')?.textContent ?? '';
const click = async (selector: string) => {
  document.querySelector<HTMLButtonElement>(selector)!.click();
  await flushPromises();
};
beforeEach(() => {
  setLocale('en-US');
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
  vi.useRealTimers();
});

describe('resource query dialog', () => {
  it('isolates source failures, sends the TV query and appends pages without duplicate releases', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('integration-preferences')) return Response.json(preferences);
      expect(url.searchParams.get('mediaType')).toBe('tv');
      expect(url.searchParams.get('query')).toBe('MobLand S01');
      if (url.pathname.includes('hdarea')) return Response.json({ error: { code: 'RESOURCE_SITE_FAILED', details: { reason: 'timeout' } } }, { status: 504 });
      return Response.json(url.searchParams.get('page') === '2'
        ? { releases: [{ id: '1', title: 'MobLand S01E01' }, { id: '2', title: 'MobLand S01E02' }] }
        : { releases: [{ id: '1', title: 'MobLand S01E01', description: 'First episode', detailsUrl: 'https://kp.m-team.cc/detail/1' }], nextPage: 2 });
    });
    vi.stubGlobal('fetch', fetcher);
    render();
    await flushPromises();
    expect(text()).toContain('MobLand S01E01');
    expect(text()).not.toContain('First episode');
    expect(document.querySelector('dialog [role=alert]')?.textContent).toContain('timed out');
    expect(document.querySelector<HTMLAnchorElement>('.release-detail-link')?.href).toBe('https://kp.m-team.cc/detail/1');
    await click('.resource-query-more');
    expect(document.querySelectorAll('.release-card')).toHaveLength(2);
    expect(document.querySelector('.resource-query-more')).toBeNull();
    const refresh = document.querySelector<HTMLButtonElement>('.release-site-refresh')!;
    refresh.click();
    await flushPromises();
    expect(document.querySelectorAll('.release-card')).toHaveLength(1);
  });

  it('filters each site independently and applies the selection to subsequent pages', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('integration-preferences')) return Response.json(preferences);
      return Response.json(url.searchParams.get('page') === '2'
        ? { releases: [{ id: '4', title: 'Next episode', resolution: '4K', tags: ['中字'] }] }
        : { releases: [
            { id: '1', title: '4K subtitles', resolution: '4K', tags: ['中字'] },
            { id: '2', title: 'HD subtitles', resolution: '1080p', tags: ['中字'] },
            { id: '3', title: '4K no subtitles', resolution: '4K', tags: [] },
          ], nextPage: 2 });
    });
    vi.stubGlobal('fetch', fetcher);
    render();
    await flushPromises();
    const sites = [...document.querySelectorAll('.release-site-group')];
    const first = sites[0]!;
    const second = sites[1]!;
    const tag = (label: string) => [...first.querySelectorAll<HTMLButtonElement>('.release-tag-filter')].find((button) => button.textContent?.trim() === label)!;
    expect(first.querySelector('.release-site-refresh .release-site-count')?.textContent).toBe('3');
    expect(first.querySelector('.release-site-status')?.textContent).toBe('');
    expect(first.querySelectorAll('.release-card')).toHaveLength(3);
    expect(first.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    tag('4K').click();
    await flushPromises();
    expect(first.querySelectorAll('.release-card')).toHaveLength(2);
    tag('Chinese subtitles').click();
    await flushPromises();
    expect(first.querySelectorAll('.release-card')).toHaveLength(1);
    expect(second.querySelectorAll('.release-card')).toHaveLength(3);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('resource-search'))).toHaveLength(2);
    first.querySelector<HTMLButtonElement>('.resource-query-more')!.click();
    await flushPromises();
    expect(first.querySelectorAll('.release-card')).toHaveLength(2);
    expect(first.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    const secondTag = second.querySelector<HTMLButtonElement>('.release-tag-filter')!;
    secondTag.click();
    await flushPromises();
    first.querySelector<HTMLButtonElement>('.release-site-reset')!.click();
    await flushPromises();
    expect(first.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(secondTag.getAttribute('aria-pressed')).toBe('true');
    expect(first.querySelector('.release-site-refresh .release-site-count')?.textContent).toBe('4');
    expect(first.hasAttribute('open')).toBe(true);
    expect(first.querySelectorAll('.release-card')).toHaveLength(4);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('resource-search'))).toHaveLength(3);
  });

  it.each(['en-US', 'zh-CN'] as const)('uses the backend remaining time instead of a rate-limit message in %s', async (locale) => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    setLocale(locale);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname.endsWith('integration-preferences')) return Response.json(preferences);
      if (url.pathname.endsWith('download-providers')) return Response.json({ providers: [] });
      if (url.pathname.endsWith('remote-client')) return Response.json({ hasKey: false, devices: [] });
      if (url.pathname.endsWith('resource-downloads')) return Response.json({ items: [] });
      if (url.searchParams.get('refresh') === 'true') return Response.json({ error: {
        code: 'RESOURCE_REFRESH_RATE_LIMITED', message: 'Do not show this error text', details: { retryAfterSeconds: 12 },
      } }, { status: 429, headers: { 'Retry-After': '12' } });
      return Response.json({ releases: [{ id: '1', title: 'Retained release' }] });
    }));
    render();
    await flushPromises();
    await click('.release-site-refresh');
    const button = document.querySelector<HTMLButtonElement>('.release-site-refresh')!;
    expect(button.textContent).toContain(locale === 'en-US' ? 'Refresh in 12s' : '12 秒后可重新获取');
    expect(button.disabled).toBe(true);
    expect(document.querySelector('.browse-error')).toBeNull();
    expect(document.querySelectorAll('.release-card')).toHaveLength(2);
    expect(document.querySelectorAll<HTMLButtonElement>('.release-site-refresh')[1]?.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain(locale === 'en-US' ? 'Refresh' : '重新获取');
  });

  it('aborts on close, ignores late responses and restores scroll and focus', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    let finish!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('integration-preferences')) return Response.json({ ...preferences, effectiveSites: ['mteam'] });
      signal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }));
    const wrapper = render();
    await flushPromises();
    expect(document.body.style.overflow).toBe('hidden');
    document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);
    mounted.splice(mounted.indexOf(wrapper), 1);
    wrapper.unmount();
    expect(signal?.aborted).toBe(true);
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
    finish(Response.json({ releases: [{ id: 'late', title: 'Old results' }] }));
    await flushPromises();
    expect(document.querySelector('dialog')).toBeNull();
  });

  it('shows the Chinese empty result and does not query unselected sites', async () => {
    setLocale('zh-CN');
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('integration-preferences')
      ? Response.json({ ...preferences, effectiveSites: ['hdarea'] })
      : Response.json({ releases: [] }));
    vi.stubGlobal('fetch', fetcher);
    render();
    await flushPromises();
    expect(text()).toContain('未找到匹配的资源。');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/mteam/releases'))).toBe(false);
    expect(document.querySelectorAll('.release-site-group')).toHaveLength(1);
  });

  it('shows configuration guidance when no resource site is selected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...preferences, effectiveSites: [] })));
    render();
    await flushPromises();
    expect(text()).toContain('Configure a resource site first');
    expect(document.querySelectorAll('.release-site-group')).toHaveLength(0);
  });
});
