// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { usePageScroll } from './page-scroll.composable';

const wrappers: ReturnType<typeof mount>[] = [];
function createScroll() {
  let scroll!: ReturnType<typeof usePageScroll>;
  const wrapper = mount(defineComponent({
    setup() {
      scroll = usePageScroll();
      return () => h('div');
    },
  }));
  wrappers.push(wrapper);
  return { scroll, wrapper };
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

it('cancels a queued restoration when navigation scrolls to a new page', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('scrollTo', vi.fn());
  const { scroll } = createScroll();
  window.history.replaceState({ listPage: 'list', scrollY: 640 }, '', '/');
  scroll.restorePosition('list');
  scroll.scrollPageTo({ top: 0, behavior: 'smooth' });
  await nextTick();
  frames.forEach((callback) => callback(0));
  expect(window.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior: 'smooth' });
});

it('removes listeners, restores browser behavior and cancels pending restoration on unmount', async () => {
  const removeListener = vi.spyOn(window, 'removeEventListener');
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('scrollTo', vi.fn());
  window.history.scrollRestoration = 'auto';
  const { scroll, wrapper } = createScroll();
  expect(window.history.scrollRestoration).toBe('manual');
  scroll.restorePosition('list');
  wrapper.unmount();
  await nextTick();
  frames.forEach((callback) => callback(0));
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(window.history.scrollRestoration).toBe('auto');
  expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  expect(removeListener).toHaveBeenCalledWith('resize', expect.any(Function));
});
