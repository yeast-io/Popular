import assert from 'node:assert/strict';
import test from 'node:test';
import { probeOpenAI } from './connection-probe.js';
test('only retrieves the configured model metadata, without generation or prompts', async () => {
  let input: unknown;
  await probeOpenAI({ models: { retrieve: async (request: unknown) => { input = request; return { object: 'model', id: 'configured-model' }; } } } as never, 'configured-model');
  assert.equal(input, 'configured-model');
});
test('maps provider failures to safe reasons without raw SDK errors or secret-bearing causes', async () => {
  for (const [error, reason] of [
    [{ status: 401 }, 'authentication'], [{ status: 403 }, 'authentication'],
    [{ status: 429, code: 'insufficient_quota' }, 'quota'], [{ status: 429 }, 'rate_limit'],
    [{ status: 404 }, 'model'], [{ status: 500, message: 'secret-private-api-key' }, 'request_failed'],
  ] as const) {
    await assert.rejects(() => probeOpenAI({ models: { retrieve: async () => { throw error; } } } as never, 'model'), failure => {
      assert.equal((failure as { reason: string }).reason, reason); assert.equal((failure as Error).cause, undefined);
      assert.equal(JSON.stringify(failure).includes('secret-private-api-key'), false); return true;
    });
  }
  await assert.rejects(() => probeOpenAI({ models: { retrieve: async () => ({ object: 'model', id: '' }) } } as never, 'model'), { reason: 'invalid_response' });
});
