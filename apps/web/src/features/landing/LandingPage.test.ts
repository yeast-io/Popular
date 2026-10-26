// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../../i18n';
import LandingPage from './LandingPage.vue';

describe('product introduction', () => {
  afterEach(() => setLocale('zh-CN'));

  it('explains the download workflow in both languages and routes calls to action to sign in', async () => {
    setLocale('zh-CN');
    const wrapper = mount(LandingPage, { props: { aiEnabled: false } });
    expect(wrapper.get('h1').text()).toContain('一个下载入口');
    expect(wrapper.find('.lp-footer .brand-logo-mark').exists()).toBe(true);
    expect(wrapper.get('.lp-footer-social').attributes('href')).toBe('https://github.com/yeast-io/Popular');
    expect(wrapper.get('.lp-footer-links a:last-child').attributes('href')).toBe('https://github.com/yeast-io/Popular/issues');
    expect(wrapper.findAll('.lp-resource-row')).toHaveLength(2);
    expect(wrapper.get('.lp-resource-list').text()).toContain('Deep Space Echoes 2025');
    expect(wrapper.get('.lp-resource-list').text()).toContain('8.6 GB');
    expect(wrapper.get('.lp-resource-list').text()).toContain('1,286');
    expect(wrapper.findAll('.lp-feature')).toHaveLength(3);
    expect(wrapper.get('.lp-hero').text()).not.toMatch(/M-Team|HDArea|qBittorrent|Transmission|Telegram|WhatsApp/);
    expect(wrapper.get('.la-agent-logo').attributes('alt')).toBe('Popular Link Agent');
    await wrapper.get('.la-link').trigger('click');
    expect(wrapper.emitted('agent')).toHaveLength(1);
    expect(wrapper.text()).not.toContain('AI 助手');
    await wrapper.get('.lp-hero-actions .lp-button').trigger('click');
    await wrapper.get('.lp-closing .lp-button').trigger('click');
    await wrapper.get('.lp-signin').trigger('click');
    expect(wrapper.emitted('login')).toHaveLength(3);
    expect(wrapper.emitted('register')).toBeUndefined();
    await wrapper.get('.lp-text-button').trigger('click');
    expect(wrapper.emitted('browse')).toHaveLength(1);
    await wrapper.get('.lp-language').trigger('click');
    expect(wrapper.get('h1').text()).toContain('One download hub');
    expect(wrapper.get('.lp-disclaimer').text()).toContain('Disclaimer');
    expect(wrapper.get('.lp-resource-list').text()).toContain('Seeders');
    expect(wrapper.get('.lp-hero').text()).not.toMatch(/M-Team|HDArea|qBittorrent|Transmission|Telegram|WhatsApp/);
    await wrapper.setProps({ aiEnabled: true });
    expect(wrapper.get('.lp-ai').text()).toContain('AI ASSISTANT');
    wrapper.unmount();
  });
});
