// @vitest-environment happy-dom
import { defineComponent, KeepAlive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import MediaSearchBox from './MediaSearchBox.vue';
import { setLocale } from '../../i18n';

const wrappers: ReturnType<typeof mount>[] = [];
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

it.each([
  ['en-US', 'Search movies', 'Close search', 'Search movies (search active)'],
  ['zh-CN', '搜索电影', '收起搜索', '搜索电影（搜索条件已生效）'],
] as const)('opens, focuses and collapses search without discarding the query in %s', async (locale, label, closeLabel, activeLabel) => {
  setLocale(locale);
  const wrapper = mount(MediaSearchBox, { props: { modelValue: '', label, placeholder: label }, attachTo: document.body });
  wrappers.push(wrapper);
  const toggle = wrapper.get<HTMLButtonElement>('.floating-search-toggle');
  const field = wrapper.get<HTMLInputElement>('input[type="search"]');
  expect(toggle.attributes('aria-expanded')).toBe('false');
  expect(field.isVisible()).toBe(false);
  expect(toggle.attributes('aria-label')).toBe(label);
  await toggle.trigger('click');
  await flushPromises();
  expect(toggle.attributes('aria-expanded')).toBe('true');
  expect(toggle.attributes('aria-label')).toBe(closeLabel);
  expect(field.isVisible()).toBe(true);
  expect(document.activeElement).toBe(field.element);
  await field.setValue('The Bear');
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['The Bear']);
  await wrapper.setProps({ modelValue: 'The Bear' });
  await field.trigger('keydown', { key: 'Escape' });
  expect(field.isVisible()).toBe(false);
  expect(document.activeElement).toBe(toggle.element);
  expect(toggle.attributes('aria-label')).toBe(activeLabel);
  expect(wrapper.find('.floating-search-indicator').exists()).toBe(true);
  await toggle.trigger('click');
  await flushPromises();
  expect(field.element.value).toBe('The Bear');
  await field.setValue('');
  await wrapper.setProps({ modelValue: '' });
  await toggle.trigger('click');
  expect(wrapper.find('.floating-search-indicator').exists()).toBe(false);
});

it('closes on an outside pointer action without stealing focus from its target', async () => {
  setLocale('en-US');
  const wrapper = mount(MediaSearchBox, { props: { modelValue: 'saved query', label: 'Search TV shows', placeholder: 'Search TV shows' }, attachTo: document.body });
  wrappers.push(wrapper);
  await wrapper.get('.floating-search-toggle').trigger('click');
  await flushPromises();
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await flushPromises();
  expect(wrapper.get('.floating-search-toggle').attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(outside);
  expect(wrapper.props('modelValue')).toBe('saved query');
});

it('places the active catalog search in the header and removes it while deactivated', async () => {
  document.body.innerHTML = '<nav><div id="header-media-search"></div><button>Movies</button></nav>';
  const wrapper = mount(defineComponent({
    components: { MediaSearchBox, KeepAlive },
    data: () => ({ visible: true }),
    template: '<KeepAlive><MediaSearchBox v-if="visible" model-value="saved" label="Search movies" placeholder="Search movies" /></KeepAlive>',
  }), { attachTo: document.body });
  wrappers.push(wrapper);
  await flushPromises();
  const header = document.getElementById('header-media-search')!;
  expect(header.querySelectorAll('.floating-search-toggle')).toHaveLength(1);
  await wrapper.setData({ visible: false });
  expect(header.querySelector('.floating-search-toggle')).toBeNull();
  await wrapper.setData({ visible: true });
  await flushPromises();
  expect(header.querySelectorAll('.floating-search-toggle')).toHaveLength(1);
  expect(header.querySelector('input')?.value).toBe('saved');
});
