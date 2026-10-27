// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import OpenAISettings from './OpenAISettings.vue';

beforeEach(() => setLocale('en-US'));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('saves and replaces the key, clears the input, then confirms deletion', async () => {
  const requests: Array<{ method: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push({ method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json(method === 'GET' ? { configured: false } : { configured: true, maskedApiKey: '••••1234', validation: { method: 'model_list', status: 'valid', checkedAt: '2026-10-18T00:00:00Z', models: ['model-a'] } });
    })
  );
  const wrapper = mount(OpenAISettings);
  await flushPromises();
  expect(wrapper.text()).toContain('Not configured');
  await wrapper.get('input').setValue('sk-test-private-api-key-1234');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(requests).toContainEqual({ method: 'PUT', body: { apiKey: 'sk-test-private-api-key-1234' } });
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  expect(wrapper.text()).toContain('••••1234');
  expect(wrapper.text()).toContain('Your key has been verified and saved.');
  expect(wrapper.text()).not.toContain('sk-test-private');
  await wrapper.get('input').setValue('sk-test-replacement-key-1234');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(requests).toContainEqual({ method: 'PUT', body: { apiKey: 'sk-test-replacement-key-1234' } });
  await wrapper.get('button.danger').trigger('click');
  expect(wrapper.text()).not.toContain('Your key has been verified and saved.');
  expect(wrapper.get('.openai-delete-confirmation').text()).toContain('Delete the key');
  expect(wrapper.find('button[type="submit"]').exists()).toBe(false);
  expect(requests.some(({ method }) => method === 'DELETE')).toBe(false);
  await wrapper.get('button.danger').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Not configured');
  expect(wrapper.text()).toContain('API key deleted');
  wrapper.unmount();
});

it('keeps connection load failures visible while the configuration form is collapsed', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, { status: 503 }))
  );
  const wrapper = mount(OpenAISettings, { attachTo: document.body });
  await flushPromises();
  expect(wrapper.get('.integration-disclosure').attributes('aria-expanded')).toBe('false');
  expect(wrapper.get('.connection-card-notice').isVisible()).toBe(true);
  expect(wrapper.get('.connection-card-notice').attributes('role')).toBe('alert');
  wrapper.unmount();
});

it('verifies the saved key and allows verifying an unsaved replacement without displaying old models', async () => {
  const validation = {
    method: 'model_list',
    status: 'valid',
    checkedAt: '2026-10-18T00:00:00Z',
    models: ['configured-model', 'other-model'],
  };
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    return Response.json({
      configured: true,
      maskedApiKey: '••••1234',
      model: 'configured-model',
      ...(url.endsWith('/test') ? { validation } : {}),
    }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(OpenAISettings);
  await flushPromises();
  expect(wrapper.text()).toContain('Configured (not validated)');
  await wrapper.get('.integration-disclosure').trigger('click');
  expect(wrapper.text()).not.toContain('Current model:');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect(wrapper.get('.integration-status').text()).toBe('Connection verified');
  expect(wrapper.text()).toContain('Last tested:');
  const [, init] = fetchMock.mock.calls.find(([url]) => url.endsWith('/test'))! as [string, RequestInit];
  expect(init.method).toBe('POST');
  expect(init.body).toBeUndefined();
  expect(init.credentials).toBe('include');
  await wrapper.get('input').setValue('sk-unsaved-replacement-key');
  expect(wrapper.get('.openai-test-button').attributes('disabled')).toBeUndefined();
  expect(wrapper.find('select').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('Current model:');
  wrapper.unmount();
});

it('shows a persisted failure while collapsed instead of pretending the key is still unvalidated', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return Response.json({
        configured: true,
        maskedApiKey: '••••1234',
        validation: {
          method: 'model_list',
          status: 'failed',
          checkedAt: '2026-10-18T00:00:00Z',
          models: ['configured-model', 'other-model'],
          failureReason: 'quota',
        },
      }
      );
    })
  );
  const wrapper = mount(OpenAISettings, { attachTo: document.body });
  await flushPromises();
  expect(wrapper.get('.integration-status').text()).toBe('Verification failed');
  expect(wrapper.get('.connection-card-notice').isVisible()).toBe(true);
  expect(wrapper.get('.connection-card-notice').text()).toContain('quota');
  wrapper.unmount();
});

it('displays fetched models and persists selection without sending the key', async () => {
  const validation = {
    method: 'model_list',
    status: 'valid',
    checkedAt: '2026-10-18T00:00:00Z',
    models: ['model-a', 'model-b'],
  };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    return Response.json({
      configured: true,
      maskedApiKey: '••••1234',
      validation,
      model: init?.body ? JSON.parse(String(init.body)).model : 'model-a',
    }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(OpenAISettings);
  await flushPromises();
  expect(wrapper.findAll('select option').map((option) => option.attributes('value'))).toEqual([
    '',
    'model-a',
    'model-b',
  ]
  );
  await wrapper.get('select').setValue('model-b');
  await flushPromises();
  expect(fetchMock).toHaveBeenLastCalledWith(
    expect.stringContaining('/openai/model'),
    expect.objectContaining({
      method: 'PUT',
      credentials: 'include',
      body: JSON.stringify({ model: 'model-b' }),
    })
  );
  expect(wrapper.text()).toContain('Current model: model-b');
  expect(wrapper.text()).toContain('Model saved.');
  await wrapper.get('input').setValue('sk-unsaved-replacement-key');
  expect(wrapper.find('select').exists()).toBe(false);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  wrapper.unmount();
});

it('handles an authenticated empty model list without offering a selection', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return Response.json({
        configured: true,
        validation: {
          method: 'model_list',
          status: 'valid',
          checkedAt: '2026-10-18T00:00:00Z',
          models: [],
        },
      }
      );
    })
  );
  const wrapper = mount(OpenAISettings);
  await flushPromises();
  expect(wrapper.text()).toContain('no curated models are visible to this key');
  expect(wrapper.get('select').attributes('disabled')).toBeDefined();
  wrapper.unmount();
});

it('hides all model information before verification and separates deletion confirmation from feedback', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    configured: true, maskedApiKey: '••••1234', model: 'gpt-5.6-sol',
  })));
  const wrapper = mount(OpenAISettings);
  await flushPromises();
  expect(wrapper.text()).not.toContain('gpt-5.6-sol');
  expect(wrapper.find('select').exists()).toBe(false);
  await wrapper.get('button.danger').trigger('click');
  expect(wrapper.find('.openai-delete-confirmation').exists()).toBe(true);
  expect(wrapper.find('.openai-delete-confirmation .integration-actions span').exists()).toBe(false);
  expect(wrapper.find('button[type="submit"]').exists()).toBe(false);
  wrapper.unmount();
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  it(`verifies a new key, saves only on success and clears stale feedback on deletion (${locale})`, async () => {
    setLocale(locale);
    let resolveVerification!: (value: Response) => void;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Promise<Response>((resolve) => {
        resolveVerification = resolve;
      });
      return Response.json({ configured: false, model: 'hidden-default' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(OpenAISettings);
    await flushPromises();
    expect(wrapper.get('button.danger').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).not.toContain('hidden-default');
    await wrapper.get('input').setValue('sk-test-new-private-api-key');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.get('button.danger').attributes('disabled')).toBeDefined();
    expect(wrapper.find('select').exists()).toBe(false);
    resolveVerification(Response.json({ configured: true, maskedApiKey: '••••-key', model: 'model-a',
      validation: { method: 'model_list', status: 'valid', checkedAt: '2026-10-18T00:00:00Z', models: ['model-a', 'model-b'] } }));
    await flushPromises();
    expect(wrapper.get('button.danger').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('select').exists()).toBe(true);
    expect(wrapper.text()).toContain(locale === 'zh-CN' ? '你的密钥已验证可用并已保存' : 'Your key has been verified and saved.');
    await wrapper.get('button.danger').trigger('click');
    expect(wrapper.find('.settings-message.success').exists()).toBe(false);
    expect(wrapper.get('.openai-delete-confirmation').findAll('button')).toHaveLength(2);
    expect(wrapper.find('button[type="submit"]').exists()).toBe(false);
    wrapper.unmount();
  });
}

it('keeps the saved key after a failed replacement and restores the selected model after a failed model save', async () => {
  const configured = { configured: true, maskedApiKey: '••••1234', model: 'model-a',
    validation: { method: 'model_list', status: 'valid', checkedAt: '2026-10-18T00:00:00Z', models: ['model-a', 'model-b'] } };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    return init?.method === 'PUT'
      ? Response.json({ error: { code: 'INTEGRATION_VALIDATION_FAILED', details: { provider: 'openai', reason: 'authentication' } } }, { status: 400 })
      : Response.json(configured);
  }));
  const wrapper = mount(OpenAISettings);
  await flushPromises();
  await wrapper.get('select').setValue('model-b');
  await flushPromises();
  expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('model-a');
  await wrapper.get('input').setValue('sk-test-invalid-replacement');
  await wrapper.get('form').trigger('submit');
  await flushPromises();
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('sk-test-invalid-replacement');
  expect(wrapper.text()).toContain('••••1234');
  expect(wrapper.text()).toContain('The key is invalid');
  expect(wrapper.find('select').exists()).toBe(false);
  expect(wrapper.get('button.danger').attributes('disabled')).toBeUndefined();
  expect(wrapper.find('.success').exists()).toBe(false);
  wrapper.unmount();
});
