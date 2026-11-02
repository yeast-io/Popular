import assert from 'node:assert/strict';
import test from 'node:test';
import { probeAiModels } from './ai-connection-probe.adapter.js';

test('Claude paginated model listing follows cursors at the fixed official address without generation', async () => {
  const urls: string[] = [];
  const models = await probeAiModels({ provider: 'claude', apiKey: 'private', timeoutMs: 1000,
    fetch: async (url, options) => {
      urls.push(String(url));
      assert.equal(options?.method, 'GET');
      assert.equal(new Headers(options?.headers).get('x-api-key'), 'private');
      return Response.json(urls.length === 1
        ? { data: [{ id: 'claude-opus-5-5' }], has_more: true, last_id: 'cursor' }
        : { data: [{ id: 'claude-sonnet-5-5' }], has_more: false });
    },
  });
  assert.deepEqual(urls, ['https://api.anthropic.com/v1/models', 'https://api.anthropic.com/v1/models?after_id=cursor']);
  assert.deepEqual(models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
});

test('invalid lists, repeated pagination and HTTP failures are classified without exposing upstream bodies', async () => {
  for (const status of [401, 402, 429]) {
    await assert.rejects(probeAiModels({ provider: 'deepseek', apiKey: 'private', timeoutMs: 1000,
      fetch: async () => new Response('sensitive body', { status }),
    }), { reason: status === 401 ? 'authentication' : status === 402 ? 'quota' : 'rate_limit' });
  }
  await assert.rejects(probeAiModels({ provider: 'claude', apiKey: 'private', timeoutMs: 1000,
    fetch: async () => Response.json({ data: [{ id: 'model' }], has_more: true, last_id: 'same' }),
  }), { reason: 'invalid_response' });
});
