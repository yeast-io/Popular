// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../i18n';
import AiChat from './AiChat.vue';

const createdAt = '2026-10-16T00:00:00.000Z';
const threadId = '507f1f77bcf86cd799439011';
const newThreadId = '507f1f77bcf86cd799439012';

describe('AI chat', () => {
  beforeEach(() => {
    setLocale('en-US');
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' });
    HTMLElement.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('loads conversation history and sends a complete turn', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/me/integrations/openai')) return Response.json({ configured: true });
        const method = init?.method ?? 'GET';
        requests.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (url.endsWith('/conversations') && method === 'GET') {
          return Response.json({
            items: [
              {
                id: threadId,
                title: 'Science fiction',
                status: 'active',
                nextSequence: 3,
                lastMessageAt: createdAt,
                createdAt,
                updatedAt: createdAt,
              },
            ],
          }
          );
        }
        if (url.endsWith(`/conversations/${threadId}/messages?limit=100`)) {
          return Response.json({
            items: [
              { id: 'message-1', threadId, sequence: 1, role: 'user', content: 'Suggest a film', createdAt },
              { id: 'message-2', threadId, sequence: 2, role: 'assistant', content: 'Watch Arrival.', createdAt },
            ],
          }
          );
        }
        if (url.endsWith(`/conversations/${threadId}/turns/stream`) && method === 'POST') {
          return sseResponse([
            {
              type: 'user_message',
              message: {
                id: 'message-3',
                threadId,
                sequence: 3,
                role: 'user',
                content: 'Something newer',
                clientRequestId: 'request-1',
                createdAt,
              },
            },
            { type: 'delta', delta: 'Try Dune' },
            { type: 'delta', delta: ': Part Two.' },
            {
              type: 'completed',
              assistantMessage: {
                id: 'message-4',
                threadId,
                sequence: 4,
                role: 'assistant',
                content: 'Try Dune: Part Two.',
                createdAt,
              },
              usage: { inputTokens: 30, outputTokens: 8 },
            },
          ]
          );
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    const wrapper = mount(AiChat);
    await flushPromises();
    expect(wrapper.text()).toContain('Science fiction');
    expect(wrapper.text()).toContain('Watch Arrival.');

    await wrapper.get('textarea').setValue('Something newer');
    await wrapper.get('.ai-composer').trigger('submit');
    await flushPromises();

    expect(wrapper.text()).toContain('Try Dune: Part Two.');
    expect(requests).toContainEqual({
      url: `/api/v1/conversations/${threadId}/turns/stream`,
      method: 'POST',
      body: { content: 'Something newer', clientRequestId: 'request-1' },
    }
    );
    wrapper.unmount();
  });

  it('creates and selects a new conversation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/me/integrations/openai')) return Response.json({ configured: true });
        const method = init?.method ?? 'GET';
        if (url.endsWith('/conversations') && method === 'GET') return Response.json({ items: [] });
        if (url.endsWith('/conversations') && method === 'POST') {
          return Response.json(
            {
              id: newThreadId,
              status: 'active',
              nextSequence: 1,
              createdAt,
              updatedAt: createdAt,
            },
            { status: 201 },
          );
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    const wrapper = mount(AiChat);
    await flushPromises();
    expect(wrapper.text()).toContain('No conversations yet.');

    await wrapper.get('.ai-new-chat').trigger('click');
    await flushPromises();

    expect(wrapper.get('.ai-thread').classes()).toContain('active');
    expect(wrapper.text()).toContain('New conversation');
    wrapper.unmount();
  });
});

function sseResponse(events: unknown[]): Response {
  return new Response(
    events
      .map((event) => {
        return `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;
      })
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    },
  );
}

describe('AI account key gate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it.each([false, 'failure'])('disables chat when key configuration is %s', async (configured) => {
    setLocale('en-US');
    const fetchMock = vi.fn(async (input: unknown) => {
      if (String(input).endsWith('/me/integrations/openai')) {
        if (configured === 'failure') return Response.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, { status: 503 });
        return Response.json({ configured: false });
      }
      return Response.json({ items: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(AiChat);
    await flushPromises();
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).disabled).toBe(true);
    expect((wrapper.get('.ai-new-chat').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.get('.ai-composer').trigger('submit');
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('/turns'))).toBe(true);
    await wrapper.get('.ai-key-required button').trigger('click');
    expect(wrapper.emitted('open-settings')).toHaveLength(1);
    wrapper.unmount();
  });
});
