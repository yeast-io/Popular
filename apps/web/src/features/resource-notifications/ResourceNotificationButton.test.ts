// @vitest-environment happy-dom
import { defineComponent, ref } from 'vue';
import ResourceNotificationFeedback from './ResourceNotificationFeedback.vue';
import type { ResourceNotificationFeedback as ResourceNotificationFeedbackState } from './resource-notification.types';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import ResourceNotificationButton from './ResourceNotificationButton.vue';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('adds/removes independently of watchlist and displays the notified state', async () => {
  setLocale('en-US');
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ enabled: false }))
    .mockResolvedValueOnce(Response.json({ enabled: true, status: 'pending' }))
    .mockResolvedValueOnce(Response.json({ enabled: false }));
  vi.stubGlobal('fetch', fetch);
  const wrapper = mount(ResourceNotificationButton, { props: { tmdbId: 42, mediaType: 'movie', authenticated: true } });
  await flushPromises();
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(fetch.mock.calls[1]![0]).toContain('/me/resource-notifications/movie/42?locale=en-US');
  expect(fetch.mock.calls[1]![1].method).toBe('PUT');
  expect(wrapper.get('button').attributes('aria-pressed')).toBe('true');
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(fetch.mock.calls[2]![1].method).toBe('DELETE');
  expect(wrapper.get('button').attributes('aria-pressed')).toBe('false');
  wrapper.unmount();
});

it.each(['zh-CN', 'en-US'] as const)(
  'shows the communication settings link in %s when no channel is configured',
  async (locale) => {
    setLocale(locale);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ enabled: false }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'RESOURCE_NOTIFICATION_CHANNEL_REQUIRED', message: 'untrusted server message' } },
          { status: 409 }
        )
      );
    vi.stubGlobal('fetch', fetch);
    const wrapper = mount(defineComponent({
      components: { ResourceNotificationButton, ResourceNotificationFeedback },
      setup() {
        const feedback = ref<ResourceNotificationFeedbackState | null>(null);
        return { feedback };
      },
      template: '<div><div class="actions"><ResourceNotificationButton media-type="tv" :tmdb-id="42" authenticated @feedback="feedback = $event" /></div><ResourceNotificationFeedback :feedback="feedback" /></div>',
    }));
    await flushPromises();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain(
      locale === 'zh-CN' ? '请先配置通信工具' : 'Configure a communication tool'
    );
    expect(wrapper.get('a').attributes('href')).toBe('/settings?section=messages');
    expect(wrapper.get('.actions').find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').element.closest('.actions')).toBeNull();
    expect(wrapper.get('button').attributes('aria-pressed')).toBe('false');
    fetch.mockResolvedValueOnce(Response.json({ enabled: true, status: 'pending' }));
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('button').attributes('aria-pressed')).toBe('true');
    wrapper.unmount();
  }
);

it('guests request login without making a private API call', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const wrapper = mount(ResourceNotificationButton, { props: { tmdbId: 42, mediaType: 'tv', authenticated: false } });
  await wrapper.get('button').trigger('click');
  expect(wrapper.emitted('requireLogin')).toHaveLength(1);
  expect(fetch).not.toHaveBeenCalled();
  wrapper.unmount();
});

it('ignores stale responses after navigating to a different title', async () => {
  let resolveOld!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce(Response.json({ enabled: false }))
  );
  const wrapper = mount(ResourceNotificationButton, { props: { tmdbId: 1, mediaType: 'movie', authenticated: true } });
  await wrapper.setProps({ tmdbId: 2 });
  await flushPromises();
  resolveOld(Response.json({ enabled: true, status: 'notified' }));
  await flushPromises();
  expect(wrapper.get('button').attributes('aria-pressed')).toBe('false');
  wrapper.unmount();
});

it('failed membership reads offer retry without writing membership', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(Response.json({ enabled: true, status: 'notified' }));
  vi.stubGlobal('fetch', fetch);
  const wrapper = mount(ResourceNotificationButton, { props: { tmdbId: 1, mediaType: 'movie', authenticated: true } });
  await flushPromises();
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(fetch.mock.calls.every((call) => !call[1]?.method)).toBe(true);
  expect(wrapper.get('button').attributes('aria-pressed')).toBe('true');
  expect(wrapper.get('button').attributes('title')).toBe('Notified');
  wrapper.unmount();
});
