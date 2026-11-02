// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AiProviderSettings from './AiProviderSettings.vue';
import { setLocale } from '../../i18n';

afterEach(() => vi.unstubAllGlobals());

it.each(['en-US', 'zh-CN'] as const)('configures independent official providers with unique fields and the shared default action (%s)', async (locale) => {
  setLocale(locale);
  const fetchMock = vi.fn(async (url: string) => url.endsWith('/me/integration-preferences')
    ? Response.json({ defaults: { ai: 'openai' }, choices: [], effectiveSites: [], selectedSites: [] })
    : Response.json({ configured: true, maskedApiKey: '••••1234', model: 'deepseek-flash',
        validation: { status: 'valid', models: ['deepseek-flash'], checkedAt: '2026-10-30T00:00:00.000Z' } }));
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(AiProviderSettings, { props: { provider: 'deepseek' } });
  await flushPromises();
  expect(wrapper.find('#deepseek-api-key').exists()).toBe(true);
  expect(wrapper.find('#openai-api-key').exists()).toBe(false);
  expect(wrapper.get('h3').text()).toBe('DeepSeek');
  expect(wrapper.find('.integration-default-button').exists()).toBe(true);
  await wrapper.get('#deepseek-api-key').setValue('official-deepseek-key-123456');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/me/integrations/deepseek'), expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ apiKey: 'official-deepseek-key-123456' }),
  }));
  expect(wrapper.text()).not.toContain('official-deepseek-key-123456');
  wrapper.unmount();
});
