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
    expect(text()).toContain('First episode');
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
