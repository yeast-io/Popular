import assert from 'node:assert/strict';
import test from 'node:test';
import { probeOpenAI } from './connection-probe.js';
test('lists model metadata only and returns sorted unique IDs without generation', async () => {
  let calls = 0;
  const models = await probeOpenAI({
    models: {
      list: async () => {
        calls++;
        return { object: 'list', data: ['z-model', 'a-model', 'z-model'].map((id) => ({ id, object: 'model' })) };
      },
    },
  } as never
  );
  assert.equal(calls, 1);
  assert.deepEqual(models, ['a-model', 'z-model']);
  assert.deepEqual(await probeOpenAI({ models: { list: async () => ({ object: 'list', data: [] }) } } as never), []);
});
test('maps provider failures to safe reasons without raw SDK errors or secret-bearing causes', async () => {
  for (const [error, reason] of [
    [{ status: 401 }, 'authentication'],
    [{ status: 403 }, 'authentication'],
    [{ status: 429, code: 'insufficient_quota' }, 'quota'],
    [{ status: 429 }, 'rate_limit'],
    [{ status: 404 }, 'model'],
    [{ status: 500, message: 'secret-private-api-key' }, 'request_failed'],
  ] as const) {
    await assert.rejects(
      () => {
        return probeOpenAI({
          models: {
            list: async () => {
              throw error;
            },
          },
        } as never);
      },
      (failure) => {
        assert.equal((failure as { reason: string }).reason, reason);
        assert.equal((failure as Error).cause, undefined);
        assert.equal(JSON.stringify(failure).includes('secret-private-api-key'), false);
        return true;
      },
    );
  }
  await assert.rejects(
    () => {
      return probeOpenAI({
        models: {
          list: async () => {
            return { object: 'list', data: [{ object: 'model', id: '' }] };
          },
        },
      } as never
      );
    },
    { reason: 'invalid_response' },
  );
});
