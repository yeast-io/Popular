// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import MovieDetail from './MovieDetail.vue';

describe('Movie Detail trailer', () => {
  beforeEach(() => {
    (
      window as typeof window & { happyDOM: { settings: { disableIframePageLoading: boolean } } }
    ).happyDOM.settings.disableIframePageLoading = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    document.body.style.overflow = '';
    (
      window as typeof window & { happyDOM: { settings: { disableIframePageLoading: boolean } } }
    ).happyDOM.settings.disableIframePageLoading = false;
  });

  it('opens the TMDB YouTube trailer in a modal and removes the player when closed', async () => {
    setLocale('zh-CN');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return Response.json({
          tmdbId: 603,
          title: '黑客帝国',
          genres: [],
          cast: [],
          directors: [],
          trailer: {
            tmdbVideoId: 'tmdb-video-1',
            provider: 'youtube',
            providerVideoId: 'M7lc1UVf-VE',
            name: '官方预告片',
            language: 'zh',
            official: true,
          },
          userStatus: 'unwatched',
          detailSyncedAt: '2026-10-14T00:00:00.000Z',
          stale: false,
          locale: 'zh-CN',
        }
        );
      })
    );

    const wrapper = mount(MovieDetail, { attachTo: document.body, props: { tmdbId: 603, authenticated: false } });
    await flushPromises();
    const trigger = wrapper.get('.trailer-button');
    expect(trigger.text()).toContain('播放预告片');

    (trigger.element as HTMLButtonElement).focus();
    await trigger.trigger('click');
    await flushPromises();

    const dialog = document.body.querySelector<HTMLElement>('.trailer-panel');
    const iframe = dialog?.querySelector<HTMLIFrameElement>('iframe');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain('官方预告片');
    expect(iframe?.src).toBe('https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=1');
    expect(iframe?.title).toBe('黑客帝国 预告片');
    expect(iframe?.referrerPolicy).toBe('strict-origin-when-cross-origin');
    expect(document.body.style.overflow).toBe('hidden');

    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('.trailer-panel')).toBeNull();
    expect(document.body.querySelector('iframe')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it('does not render a trailer button when the movie has no trailer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return Response.json({
          tmdbId: 603,
          title: 'Movie',
          genres: [],
          cast: [],
          directors: [],
          userStatus: 'unwatched',
          detailSyncedAt: '2026-10-14T00:00:00.000Z',
          stale: false,
          locale: 'zh-CN',
        }
        );
      })
    );
    const wrapper = mount(MovieDetail, { props: { tmdbId: 603, authenticated: false } });
    await flushPromises();
    expect(wrapper.find('.trailer-button').exists()).toBe(false);
    wrapper.unmount();
  });
});
