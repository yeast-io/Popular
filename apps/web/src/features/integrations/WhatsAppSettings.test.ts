// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import WhatsAppSettings from './WhatsAppSettings.vue';

beforeEach(() => {
  setLocale('en-US');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['unbound', 'connected', 'disconnected', 'error'] as const)(
  'does not poll while status is %s', async (status) => {
    const fetchMock = vi.fn(async () => Response.json({ status }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(WhatsAppSettings);
    try {
      await flushPromises();
      await vi.advanceTimersByTimeAsync(12_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { wrapper.unmount(); }
  }
);

it('stops polling after connecting and restarts after unlinking and binding again', async () => {
  let status = 'unbound';
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/bind')) status = 'connecting';
    if (init?.method === 'DELETE') {
      status = 'unbound';
      return new Response(null, { status: 204 });
    }
    return Response.json({ status });
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(WhatsAppSettings);
  try {
    await flushPromises();
    await wrapper.get('button.primary').trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    status = 'connected';
    await vi.advanceTimersByTimeAsync(3_000);
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
    await wrapper.get('button.danger').trigger('click');
    await wrapper.get('button.danger').trigger('click');
    await flushPromises();
    await wrapper.get('button.primary').trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(count + 3);
  } finally { wrapper.unmount(); }
});

it('stops polling after a failed status request', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'pairing' }))
    .mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(WhatsAppSettings);
  try {
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally { wrapper.unmount(); }
});

it('starts QR binding, polls connection, sends self-test and confirms unlink', async () => {
  const calls: Array<{ method: string; url: string; init: RequestInit | undefined }> = [];
  let status = { status: 'unbound' } as Record<string, string>;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url: input, init });
      if (method === 'DELETE') {
        status = { status: 'unbound' };
        return new Response(null, { status: 204 });
      }
      if (input.endsWith('/bind'))
        status = {
          status: 'qr',
          qrDataUrl: 'data:image/png;base64,test',
          qrExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      if (input.endsWith('/test')) return Response.json({ messageId: 'accepted-id' });
      return Response.json(status);
    })
  );
  const wrapper = mount(WhatsAppSettings);
  await flushPromises();
  expect(wrapper.text()).toContain('Not linked');
  await wrapper.get('button.primary').trigger('click');
  await flushPromises();
  expect(wrapper.get('.whatsapp-pairing img').attributes('src')).toBe('data:image/png;base64,test');
  expect(wrapper.text()).toContain('Linked devices');
  status = { status: 'connected', account: '••••1234' };
  await vi.advanceTimersByTimeAsync(3_000);
  await flushPromises();
  expect(wrapper.find('.whatsapp-pairing img').exists()).toBe(false);
  expect(wrapper.text()).toContain('••••1234');
  await wrapper.get('button.primary').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('WhatsApp accepted');
  const sent = calls.find((call) => call.url.endsWith('/test'))!;
  expect(sent.init?.body).toBeUndefined();
  expect(sent.init?.credentials).toBe('include');
  await wrapper.get('button.danger').trigger('click');
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  await wrapper.get('button.danger').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('Not linked');
  wrapper.unmount();
  const count = calls.length;
  await vi.advanceTimersByTimeAsync(9_000);
  expect(calls).toHaveLength(count);
});

it('removes the QR when status refresh fails and does not leak it into another mount', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        status: 'qr',
        qrDataUrl: 'private-qr',
        qrExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    )
    .mockRejectedValueOnce(
      new Error('offline')
    )
    .mockResolvedValue(
      Response.json({ status: 'unbound' })
    );
  vi.stubGlobal('fetch', fetchMock);
  const first = mount(WhatsAppSettings);
  await flushPromises();
  expect(first.find('.whatsapp-pairing img').exists()).toBe(true);
  await vi.advanceTimersByTimeAsync(3_000);
  await flushPromises();
  expect(first.find('.whatsapp-pairing img').exists()).toBe(false);
  first.unmount();
  const second = mount(WhatsAppSettings);
  await flushPromises();
  expect(second.find('.whatsapp-pairing img').exists()).toBe(false);
  expect(second.text()).toContain('Not linked');
  second.unmount();
});

it('starts binding from the collapsed card action and reveals the returned QR', async () => {
  const fetchMock = vi.fn(async (input: string) => {
    return Response.json(
      input.endsWith('/bind')
        ? {
            status: 'qr',
            qrDataUrl: 'data:image/png;base64,owner-qr',
            qrExpiresAt: new Date(Date.now() + 20_000).toISOString(),
          }
        : { status: 'unbound' }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const wrapper = mount(WhatsAppSettings);
  await flushPromises();
  expect(wrapper.get('.integration-disclosure').attributes('aria-expanded')).toBe('false');
  await wrapper.get('.integration-disclosure').trigger('click');
  await flushPromises();
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/bind'))).toHaveLength(1);
  expect(wrapper.get('.whatsapp-pairing img').isVisible()).toBe(true);
  expect(wrapper.get('.whatsapp-pairing img').attributes('src')).toContain('owner-qr');
  wrapper.unmount();
});

it('explains QR disappearance during pairing and shows sanitized terminal connection diagnostics', async () => {
  let state: Record<string, unknown> = {
    status: 'qr',
    qrDataUrl: 'data:image/png;base64,qr',
    qrExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(state))
  );
  const wrapper = mount(WhatsAppSettings);
  await flushPromises();
  expect(wrapper.find('.whatsapp-pairing img').exists()).toBe(true);
  state = { status: 'pairing' };
  await vi.advanceTimersByTimeAsync(3_000);
  await flushPromises();
  expect(wrapper.find('.whatsapp-pairing img').exists()).toBe(false);
  expect(wrapper.text()).toContain('Scan accepted');
  expect(wrapper.get('button.primary').attributes('disabled')).toBeDefined();
  state = { status: 'disconnected', failureReason: 'forbidden', disconnectCode: 403 };
  await vi.advanceTimersByTimeAsync(3_000);
  await flushPromises();
  expect(wrapper.text()).toContain('WhatsApp rejected');
  expect(wrapper.text()).toContain('403');
  wrapper.unmount();
});
