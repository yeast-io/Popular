// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ResourceSiteRefresh from './ResourceSiteRefresh.vue';
import { setLocale } from '../../i18n';

afterEach(() => vi.useRealTimers());
describe('resource refresh countdown', () => {
  it.each(['en-US', 'zh-CN'] as const)('disables for 30 seconds in %s without blocking other sites', async (locale) => {
    vi.useFakeTimers();
    setLocale(locale);
    const first = mount(ResourceSiteRefresh, { props: { site: 'mteam', name: 'M-Team', loading: false, count: 27 } });
    const second = mount(ResourceSiteRefresh, { props: { site: 'hdarea', name: 'HDArea', loading: false } });
    await first.get('button').trigger('click');
    expect(first.emitted('refresh')).toHaveLength(1);
    expect(first.get('button').attributes('disabled')).toBeDefined();
    expect(first.text()).toContain('30');
    expect(first.get('.release-site-count').text()).toBe('27');
    await first.get('button').trigger('click');
    expect(first.emitted('refresh')).toHaveLength(1);
    expect(second.get('button').attributes('disabled')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(first.text()).toContain(locale === 'en-US' ? 'Refresh in 1s' : '1 秒后可重新获取');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.get('button').attributes('disabled')).toBeUndefined();
    await first.get('button').trigger('click');
    expect(first.emitted('refresh')).toHaveLength(2);
    first.unmount();
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
