import { nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from 'vue';
import type { InfiniteScrollOptions } from './infinite-scroll.types';

export function useInfiniteScroll(options: InfiniteScrollOptions) {
  let observer: IntersectionObserver | undefined;
  let active = true;
  let revision = 0;
  let pending = false;

  function stop() {
    ++revision;
    observer?.disconnect();
    observer = undefined;
  }

  async function observe() {
    stop();
    const version = revision;
    await nextTick();
    const target = options.target.value;
    if (version !== revision || !active || !target || !options.enabled() || typeof IntersectionObserver === 'undefined') return;
    let root = target.parentElement;
    while (root && !/(auto|scroll|overlay)/.test(window.getComputedStyle(root).overflowY)) root = root.parentElement;
    observer = new IntersectionObserver((entries) => {
      if (version !== revision || !active || pending || !options.enabled() || !entries.some((entry) => entry.isIntersecting)) return;
      pending = true;
      try {
        options.load();
      } finally {
        void nextTick(() => {
          pending = false;
        });
      }
    }, { root, rootMargin: '0px 0px 400px 0px', threshold: 0 });
    observer.observe(target);
  }

  watch([options.target, options.enabled], () => void observe(), { flush: 'post' });
  onMounted(() => void observe());
  onActivated(() => {
    active = true;
    void observe();
  });
  onDeactivated(() => {
    active = false;
    stop();
  });
  onBeforeUnmount(() => {
    active = false;
    stop();
  });
}
