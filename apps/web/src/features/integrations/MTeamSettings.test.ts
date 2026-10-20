// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import MTeamSettings from './MTeamSettings.vue';

describe('M-Team settings', () => {
  beforeEach(() => setLocale('en-US'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses the official default and never renders a saved API key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return Response.json({
          provider: 'mteam',
          status: 'configured_valid',
          baseUrl: 'https://api.m-team.cc',
          lastValidationAt: '2026-10-12T05:00:00.000Z',
        }
        );
      }),
    );
    const wrapper = mount(MTeamSettings);
    await flushPromises();

    expect(wrapper.get<HTMLInputElement>('#mteam-base-url').element.value).toBe('https://api.m-team.cc');
    expect(wrapper.get<HTMLInputElement>('#mteam-web-base-url').element.value).toBe('https://kp.m-team.cc');
    expect(wrapper.get<HTMLInputElement>('#mteam-api-key').element.value).toBe('');
    expect(wrapper.text()).not.toContain('saved-secret');
    expect(wrapper.text()).toContain('Configured, last validation succeeded');
  });

  it('tests new credentials and clears the API key after a successful save', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return Response.json({ provider: 'mteam', status: 'unconfigured' });
      return Response.json({
        provider: 'mteam',
        status: 'configured_valid',
        baseUrl: 'https://api.m-team.cc',
        lastValidationAt: '2026-10-12T05:00:00.000Z',
      }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(MTeamSettings);
    await flushPromises();

    await wrapper.get('#mteam-api-key').setValue('new-secret');
    await wrapper.get('.integration-form').trigger('submit');
    await flushPromises();

    const saveCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      baseUrl: 'https://api.m-team.cc',
      webBaseUrl: 'https://kp.m-team.cc',
      apiKey: 'new-secret',
    }
    );
    expect(wrapper.get<HTMLInputElement>('#mteam-api-key').element.value).toBe('');
    expect(wrapper.text()).toContain('validated and saved');
  });

  it('requires explicit confirmation before deleting', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ provider: 'mteam', status: 'configured_valid', baseUrl: 'https://api.m-team.cc' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(MTeamSettings);
    await flushPromises();

    expect(wrapper.get('.integration-delete-trigger').element.closest('.integration-actions')).not.toBeNull();
    await wrapper.get('.integration-delete-trigger').trigger('click');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await wrapper.get('.integration-delete .danger').trigger('click');
    await flushPromises();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    expect(wrapper.text()).toContain('Not configured');
  });

  it('leaves validating state immediately when validation fails even if status refresh never returns', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith(
          '/integration-preferences'
        )) return Response.json(
          { defaults: { resource: 'mteam' }, selectedSites: [], effectiveSites: ['mteam'], choices: [] }
        );
        call += 1;
        if (call === 1)
          return Response.json({
            provider: 'mteam',
            status: 'configured_valid',
            baseUrl: 'https://api.m-team.cc',
          });
        if (call === 2)
          return Response.json(
            {
              error: {
                code: 'INTEGRATION_VALIDATION_FAILED',
                message: 'failed',
                requestId: 'req-1',
                details: { failureType: 'network' },
              },
            },
            { status: 502 },
          );
        return new Promise<Response>(() => undefined);
      }),
    );
    const wrapper = mount(MTeamSettings);
    await flushPromises();

    await wrapper.get('.integration-form').trigger('submit');
    await flushPromises();

    expect(wrapper.get<HTMLButtonElement>('.integration-form .primary').element.disabled).toBe(false);
    expect(wrapper.get('.integration-form .primary').text()).toBe('Test and save');
    expect(wrapper.text()).toContain('M-Team validation failed');
    expect(wrapper.text()).toContain('Configured, last validation failed');
  });
});
