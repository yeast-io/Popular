// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ResourceSiteRefresh from './ResourceSiteRefresh.vue';
import { setLocale } from '../../i18n';

describe('resource refresh while loading', () => {
  it.each(['en-US', 'zh-CN'] as const)('disables only during a request in %s without blocking other sites', async (locale) => {
    setLocale(locale);
    const first = mount(ResourceSiteRefresh, { props: { site: 'mteam', name: 'M-Team', loading: false, count: 27 } });
    const second = mount(ResourceSiteRefresh, { props: { site: 'hdarea', name: 'HDArea', loading: false } });
    await first.get('button').trigger('click');
    expect(first.emitted('refresh')).toHaveLength(1);
    await first.setProps({ loading: true });
    expect(first.get('button').attributes('disabled')).toBeDefined();
    expect(first.get('.release-site-count').text()).toBe('27');
    await first.get('button').trigger('click');
    expect(first.emitted('refresh')).toHaveLength(1);
    expect(second.get('button').attributes('disabled')).toBeUndefined();
    await first.setProps({ loading: false });
    expect(first.get('button').attributes('disabled')).toBeUndefined();
    expect(first.text()).toContain(locale === 'en-US' ? 'Refresh' : '重新获取');
    await first.get('button').trigger('click');
    expect(first.emitted('refresh')).toHaveLength(2);
    first.unmount();
    second.unmount();
  });
});
