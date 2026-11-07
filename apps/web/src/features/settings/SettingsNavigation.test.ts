// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { expect, it } from 'vitest';
import SettingsNavigation from './SettingsNavigation.vue';
import { setLocale } from '../../i18n';

const sections = ['profile', 'language', 'ai', 'preferences', 'resources', 'downloads', 'keys', 'notifications'] as const;
for (const locale of ['en-US', 'zh-CN'] as const) {
  it(`folds resources without navigating, groups mobile options, and reopens on child navigation in ${locale}`, async () => {
    setLocale(locale);
    const wrapper = mount(SettingsNavigation, { attachTo: document.body, props: { section: 'profile', sections } });
    const group = wrapper.get('[data-settings-group="resources"]');
    expect(group.text()).toContain(locale === 'en-US' ? 'Resources' : '资源');
    expect(group.attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('#settings-resource-children').isVisible()).toBe(false);
    await group.trigger('click');
    expect(group.attributes('aria-expanded')).toBe('true');
    expect(wrapper.emitted('select')).toBeUndefined();
    const sites = wrapper.get('[data-settings-section="resources"]');
    const tools = wrapper.get('[data-settings-section="downloads"]');
    expect(sites.text()).toContain(locale === 'en-US' ? 'Sites' : '站点');
    expect(tools.text()).toContain(locale === 'en-US' ? 'Tools' : '下载工具');
    await sites.trigger('click');
    expect(wrapper.emitted('select')).toEqual([['resources']]);
    await group.trigger('click');
    await wrapper.setProps({ section: 'downloads' });
    expect(group.attributes('aria-expanded')).toBe('true');
    expect(tools.attributes('aria-current')).toBe('page');
    expect(group.attributes('aria-current')).toBeUndefined();
    const mobileGroup = wrapper.get('#settings-category optgroup');
    expect(mobileGroup.attributes('label')).toBe(locale === 'en-US' ? 'Resources' : '资源');
    expect(mobileGroup.findAll('option').map((option) => option.attributes('value'))).toEqual(['resources', 'downloads']);
    expect(wrapper.findAll('#settings-category option')).toHaveLength(sections.length);
    await wrapper.get('#settings-category').setValue('resources');
    expect(wrapper.emitted('select-mobile')).toHaveLength(1);
    wrapper.unmount();
  });
  it(`opens resources when entering a child section directly in ${locale}`, () => {
    setLocale(locale);
    for (const section of ['resources', 'downloads'] as const) {
      const wrapper = mount(SettingsNavigation, { attachTo: document.body, props: { section, sections } });
      expect(wrapper.get('[data-settings-group="resources"]').attributes('aria-expanded')).toBe('true');
      expect(wrapper.get(`[data-settings-section="${section}"]`).attributes('aria-current')).toBe('page');
      wrapper.unmount();
    }
  });
}
