// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import TvSeasonSelector from './TvSeasonSelector.vue';
import { setLocale } from '../../i18n';

const seasons = [0, 2, 1].map((number) => ({ tmdbId: 90 + number, tvShowTmdbId: 42, seasonNumber: number, name: `Season ${number}`, ...(number !== 2 ? { episodeCount: 9 } : {}) }));
const mounted: ReturnType<typeof mount>[] = [];
function render() {
  const wrapper = mount(TvSeasonSelector, { props: { modelValue: 1, seasons }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount());
  document.body.innerHTML = '';
});
describe('custom season menu', () => {
  it.each(['en-US', 'zh-CN'] as const)('renders localized options, counts and selection without a visible label (%s)', async (locale) => {
    setLocale(locale);
    const wrapper = render();
    const trigger = wrapper.get('[role=combobox]');
    expect(wrapper.find('select').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(locale === 'zh-CN' ? '选择季' : 'Choose a season');
    expect(trigger.attributes('aria-label')).toBe(locale === 'zh-CN' ? '选择季' : 'Choose a season');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    expect(wrapper.findAll('[role=option]').map((option) => option.attributes('data-season'))).toEqual(['1', '2', '0']);
    expect(wrapper.get('[aria-selected=true]').attributes('data-season')).toBe('1');
    expect(wrapper.get('[data-season="2"]').text()).toContain(locale === 'zh-CN' ? '集数未知' : 'Episode count unknown');
    await wrapper.get('[data-season="2"]').trigger('click');
    expect(wrapper.emitted('update:modelValue')).toEqual([[2]]);
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
  });
  it('supports arrows, Home, End, Enter and Escape while retaining focus on the trigger', async () => {
    setLocale('en-US');
    const wrapper = render();
    const trigger = wrapper.get('[role=combobox]');
    (trigger.element as HTMLButtonElement).focus();
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    const first = trigger.attributes('aria-activedescendant');
    expect(first).toBe(wrapper.get('[data-season="1"]').attributes('id'));
    await trigger.trigger('keydown', { key: 'End' });
    expect(trigger.attributes('aria-activedescendant')).toBe(wrapper.get('[data-season="0"]').attributes('id'));
    await trigger.trigger('keydown', { key: 'Home' });
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await trigger.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('update:modelValue')).toEqual([[2]]);
    await trigger.trigger('click');
    await trigger.trigger('keydown', { key: 'ArrowUp' });
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1);
    expect(document.activeElement).toBe(trigger.element);
  });
  it('closes on outside pointer input, Tab and changes to the available seasons', async () => {
    const wrapper = render();
    const trigger = wrapper.get('[role=combobox]');
    await trigger.trigger('click');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    await trigger.trigger('keydown', { key: 'Tab' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    await wrapper.setProps({ seasons: [] });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(trigger.attributes('disabled')).toBeDefined();
  });
});
