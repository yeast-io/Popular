// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, KeepAlive } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../i18n';
import InfiniteScroll from './InfiniteScroll.vue';

const observers: { callback: IntersectionObserverCallback; options: IntersectionObserverInit | undefined; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
const mounted: ReturnType<typeof mount>[] = [];
function intersect(index = observers.length - 1, visible = true) {
  observers[index]!.callback([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver);
}
beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      observers.push({ callback, options, observe: vi.fn(), disconnect: vi.fn() });
      return observers[observers.length - 1]!;
    }
  });
});
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('preloads near the viewport, blocks duplicate callbacks, and rechecks after each loaded page', async () => {
  const load = vi.fn();
  const wrapper = mount(InfiniteScroll, { props: { loading: false, onLoad: load } });
  mounted.push(wrapper);
  await flushPromises();
  expect(observers[0]!.options).toMatchObject({ root: null, rootMargin: '0px 0px 400px 0px' });
  intersect(0, false);
  expect(wrapper.emitted('load')).toBeUndefined();
  intersect();
  intersect();
  expect(wrapper.emitted('load')).toHaveLength(1);
  await wrapper.setProps({ loading: true });
  intersect(0);
  expect(wrapper.emitted('load')).toHaveLength(1);
  await wrapper.setProps({ loading: false });
  await flushPromises();
  intersect();
  expect(wrapper.emitted('load')).toHaveLength(2);
  wrapper.unmount();
  intersect();
  expect(load).toHaveBeenCalledTimes(2);
});

it('observes the closest scroll container in a dialog', async () => {
  const root = document.createElement('div');
  root.style.overflowY = 'auto';
  document.body.append(root);
  const wrapper = mount(InfiniteScroll, { props: { loading: false }, attachTo: root });
  mounted.push(wrapper);
  await flushPromises();
  expect(observers[0]!.options?.root).toBe(root);
});

it.each(['en-US', 'zh-CN'] as const)('pauses on failure until manual retry and localizes its status (%s)', async (locale) => {
  setLocale(locale);
  const wrapper = mount(InfiniteScroll, { props: { loading: false } });
  mounted.push(wrapper);
  await flushPromises();
  await wrapper.setProps({ failed: true });
  intersect(0);
  expect(wrapper.emitted('load')).toBeUndefined();
  expect(wrapper.get('button').text()).toBe(locale === 'en-US' ? 'Retry' : '重试');
  await wrapper.get('button').trigger('click');
  expect(wrapper.emitted('load')).toHaveLength(1);
  await wrapper.setProps({ failed: false, loading: true });
  expect(wrapper.get('[role="status"]').text()).toBe(locale === 'en-US' ? 'Loading…' : '正在加载…');
  expect(wrapper.find('button').exists()).toBe(false);
});

it('disconnects cached pages while inactive and ignores queued callbacks after category resets', async () => {
  const wrapper = mount(defineComponent({
    components: { InfiniteScroll, KeepAlive },
    data: () => ({ visible: true, disabled: false }),
    template: '<KeepAlive><InfiniteScroll v-if="visible" :loading="false" :disabled="disabled" /></KeepAlive>',
  }));
  mounted.push(wrapper);
  await flushPromises();
  const sentinel = wrapper.getComponent(InfiniteScroll);
  const old = observers.length - 1;
  await wrapper.setData({ visible: false });
  intersect(old);
  expect(sentinel.emitted('load')).toBeUndefined();
  expect(observers[old]!.disconnect).toHaveBeenCalled();
  await wrapper.setData({ visible: true });
  await flushPromises();
  await wrapper.setData({ disabled: true });
  intersect();
  expect(sentinel.emitted('load')).toBeUndefined();
  await wrapper.setData({ disabled: false });
  await flushPromises();
  intersect(old);
  expect(sentinel.emitted('load')).toBeUndefined();
  intersect();
  expect(sentinel.emitted('load')).toHaveLength(1);
});
