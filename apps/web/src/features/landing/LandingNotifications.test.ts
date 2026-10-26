// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import LandingNotifications from './LandingNotifications.vue';

describe('landing notification demonstration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setLocale('zh-CN');
    vi.stubGlobal('IntersectionObserver', undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setLocale('zh-CN');
  });

  it('shows fictional notifications and advances through user choice before download completion', async () => {
    const wrapper = mount(LandingNotifications);
    expect(wrapper.findAll('.ln-notification')).toHaveLength(2);
    expect(wrapper.findAll('.ln-phone')).toHaveLength(1);
    expect(wrapper.get('.ln-status').text()).toContain('发现可用资源');
    await wrapper.get('.ln-notification:nth-child(2)').trigger('click');
    expect(wrapper.findAll('.ln-phone')).toHaveLength(1);
    expect(wrapper.get('.ln-status').text()).toContain('下载完成');
    expect(wrapper.get('.ln-notification:nth-child(2)').attributes('aria-pressed')).toBe('true');
    expect(wrapper.text()).toContain('资源可用通知');
    expect(wrapper.text()).toContain('下载完成通知');
    expect(wrapper.get('.ln-chat').text()).not.toContain('已提交');
    await vi.advanceTimersByTimeAsync(6400);
    expect(wrapper.get('.ln-chat').text()).toContain('你想下载哪个');
    expect(wrapper.get('.ln-chat').text()).not.toContain('已提交');
    await wrapper.get('.ln-controls button').trigger('click');
    await vi.advanceTimersByTimeAsync(6400);
    expect(wrapper.get('.ln-chat').text()).not.toContain('已提交');
    await wrapper.get('.ln-controls button').trigger('click');
    await vi.advanceTimersByTimeAsync(3200);
    expect(wrapper.get('.ln-chat').text()).toContain('选第一个');
    expect(wrapper.get('.ln-chat').text()).toContain('已提交');
    await vi.advanceTimersByTimeAsync(3200);
    expect(wrapper.get('.ln-chat').text()).toContain('✓ 下载完成');
    expect(wrapper.get('.ln-controls button').attributes('aria-pressed')).toBe('false');
    await wrapper.get('.ln-controls button:last-child').trigger('click');
    expect(wrapper.get('.ln-chat').text()).not.toContain('已提交');
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the full conversation without autoplay for reduced motion and supports English', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    setLocale('en-US');
    const wrapper = mount(LandingNotifications);
    await flushPromises();
    expect(wrapper.get('.ln-chat').text()).toContain('Download complete');
    expect(wrapper.get('.ln-controls button').attributes('aria-pressed')).toBe('false');
    expect(wrapper.text()).toContain('Resource availability');
    await wrapper.get('.ln-stages button').trigger('click');
    expect(wrapper.get('.ln-chat').text()).not.toContain('Download complete');
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
