// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import TransmissionSettings from './TransmissionSettings.vue';

const saved = {
  provider: 'transmission',
  status: 'configured_valid',
  baseUrl: 'http://nas:9091',
  username: 'daniel',
  version: '4.0.6',
};

describe('Transmission settings', () => {
  beforeEach(() => setLocale('en-US'));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends only address, username and password and clears the password after saving', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return Response.json(init?.method === 'PUT' ? saved : { provider: 'transmission', status: 'unconfigured' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(TransmissionSettings);
    await flushPromises();
    expect(wrapper.findAll('input')).toHaveLength(3);
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined();
    await wrapper.get('#transmission-base-url').setValue('http://nas:9091');
    await wrapper.get('#transmission-username').setValue('daniel');
    await wrapper.get('#transmission-password').setValue('private-password');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(String(request?.[0])).toContain('/me/integrations/transmission');
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      baseUrl: 'http://nas:9091',
      username: 'daniel',
      password: 'private-password',
    }
    );
    expect((wrapper.get('#transmission-password').element as HTMLInputElement).value).toBe('');
    expect(wrapper.text()).toContain('validated and saved');
    expect(wrapper.text()).toContain('4.0.6');
  });

  it('retains the password only for the saved address and username and can retest', async () => {
    const fetchMock = vi.fn(async () => Response.json(saved));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(TransmissionSettings);
    await flushPromises();
    const submit = () => wrapper.get('button[type="submit"]');
    expect(submit().attributes('disabled')).toBeUndefined();
    await wrapper.get('#transmission-base-url').setValue('http://other:9091');
    expect(submit().attributes('disabled')).toBeDefined();
    await wrapper.get('#transmission-base-url').setValue(saved.baseUrl);
    await wrapper.get('#transmission-username').setValue('other');
    expect(submit().attributes('disabled')).toBeDefined();
    await wrapper.get('#transmission-username').setValue(saved.username);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(
      JSON.parse(String((fetchMock.mock.calls as unknown as [unknown, RequestInit?][]).at(-1)?.[1]?.body))
    ).toEqual(
      { baseUrl: saved.baseUrl, username: saved.username }
    );
    const retest = wrapper.findAll('button').find((button) => button.text() === 'Retest current configuration')!;
    await retest.trigger('click');
    await flushPromises();
    expect((fetchMock.mock.calls as unknown as [string, RequestInit?][]).at(-1)?.[0]).toContain('/transmission/test');
  });

  it('shows localized connection errors without a success message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        return init?.method === 'PUT'
          ? Response.json({ error: { code: 'TRANSMISSION_AUTH_FAILED' } }, { status: 502 })
          : Response.json(saved);
      })
    );
    const wrapper = mount(TransmissionSettings);
    await flushPromises();
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('credential is invalid');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('requires confirmation before deleting and resets the form', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(saved);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(TransmissionSettings);
    await flushPromises();
    await wrapper.get('.integration-delete-trigger').trigger('click');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await wrapper.get('.integration-delete .danger').trigger('click');
    await flushPromises();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    expect(wrapper.text()).toContain('Not configured');
    expect((wrapper.get('#transmission-username').element as HTMLInputElement).value).toBe('');
  });
});
