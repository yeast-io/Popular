// @vitest-environment happy-dom
import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import MediaTrailerDialog from './MediaTrailerDialog.vue';

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
  (window as typeof window & { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = false;
});
it('plays the TV trailer in a modal, removes the player on Escape and restores focus and scrolling', async () => {
  setLocale('zh-CN');
  (window as typeof window & { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
  });
  const host = defineComponent({ components: { MediaTrailerDialog }, data: () => ({ open: false, trailer: { tmdbVideoId: 'video', provider: 'youtube', providerVideoId: 'Safe_video-1', name: 'Official trailer', official: true } }), template: '<button @click="open=true">Play</button><MediaTrailerDialog v-if="open" :trailer="trailer" title="Series" @close="open=false" />' });
  const wrapper = mount(host, { attachTo: document.body });
  mounted.push(wrapper);
  document.body.style.overflow = 'auto';
  wrapper.get('button').element.focus();
  await wrapper.get('button').trigger('click');
  await flushPromises();
  const dialog = document.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  expect(document.activeElement?.textContent).toBe('关闭');
  const frame = document.querySelector('iframe')!;
  expect(frame.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/Safe_video-1?autoplay=1');
  expect(frame.getAttribute('title')).toBe('Series 预告片');
  dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  await flushPromises();
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(wrapper.get('button').element);
  expect(document.body.style.overflow).toBe('auto');
});
