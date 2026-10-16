// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import OpenAISettings from './OpenAISettings.vue';

beforeEach(() => setLocale('en-US'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('saves and replaces the key, clears the input, then confirms deletion', async () => {
  const requests: Array<{ method: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json(method === 'GET' ? { configured: false } : { configured: true, maskedApiKey: '••••1234' });
  }));
  const wrapper = mount(OpenAISettings);
  await flushPromises();
  expect(wrapper.text()).toContain('Not configured');
  await wrapper.get('input').setValue('sk-test-private-api-key-1234');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(requests).toContainEqual({ method: 'PUT', body: { apiKey: 'sk-test-private-api-key-1234' } });
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  expect(wrapper.text()).toContain('••••1234');
  expect(wrapper.text()).not.toContain('sk-test-private');
  await wrapper.get('input').setValue('sk-test-replacement-key-1234');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(requests).toContainEqual({ method: 'PUT', body: { apiKey: 'sk-test-replacement-key-1234' } });
  await wrapper.get('button.danger').trigger('click');
  expect(requests.some(({ method }) => method === 'DELETE')).toBe(false);
  await wrapper.get('button.danger').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Not configured');
  expect(wrapper.text()).toContain('API key deleted');
  wrapper.unmount();
});
