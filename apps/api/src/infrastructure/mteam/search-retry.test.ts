import assert from 'node:assert/strict';
import test from 'node:test';
import { IntegrationValidationError } from '../../modules/integrations/integration.service.js';
import { AiTrace, withAiTrace } from '../logging/ai-trace.js';
import { isRetryableSearchError, MTeamHttpError, parseRetryAfter, retryMTeamSearch } from './search-retry.js';

function clock() {
  let time = 0;
  const waits: number[] = [];
  return { now: () => time, advance: (ms: number) => { time += ms; }, waits,
    wait: async (ms: number) => { waits.push(ms); time += ms; }, random: () => 0 };
}
const timeout = () => new IntegrationValidationError('timeout', 'query timed out');

test('transient timeouts recover with at most three attempts and exponential delay', async () => {
  const runtime = clock();
  const attempts: number[] = [];
  const operationIds = new Set<string>();
  const result = await retryMTeamSearch(async (attempt, operationId, _signal, remainingMs) => {
    attempts.push(attempt);
    operationIds.add(operationId);
    assert.equal(remainingMs, 40_000 - runtime.now());
    if (attempt < 3) throw timeout();
    return 'releases';
  }, runtime
  );
  assert.equal(result, 'releases');
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(runtime.waits, [1000, 2000]);
  assert.equal(operationIds.size, 1);
});

test('retry exhaustion preserves the exact final error, stack and cause', async () => {
  const error = new IntegrationValidationError('timeout', 'timeout', { cause: new Error('socket timeout') });
  let calls = 0;
  await assert.rejects(retryMTeamSearch(async () => { calls++; throw error; }, clock()), (actual) => actual === error);
  assert.equal(calls, 3);
  assert.match(error.stack!, /timeout/);
  assert.equal((error.cause as Error).message, 'socket timeout');
});

test('authentication, permission, invalid payloads, unsafe addresses and business errors never retry', async () => {
  for (const error of [
    new IntegrationValidationError('authentication', 'bad key'),
    new IntegrationValidationError('permission', 'forbidden'),
    new IntegrationValidationError('invalid_response', 'malformed data'),
    new IntegrationValidationError('network', 'Private network addresses are not allowed'),
    new IntegrationValidationError('remote_error', 'business rejection'),
    new MTeamHttpError('remote_error', 400), new MTeamHttpError('remote_error', 501),
    new IntegrationValidationError('network', 'TLS failed', { cause: Object.assign(
      new Error('certificate'),
      { code: 'CERT_HAS_EXPIRED' }
    ) }),
  ]) {
    let calls = 0;
    const runtime = clock();
    await assert.rejects(
      retryMTeamSearch(async () => { calls++; throw error; }, runtime),
      (actual) => actual === error
    );
    assert.equal(calls, 1);
    assert.deepEqual(runtime.waits, []);
  }
});

test('selected HTTP failures and transient network causes are retryable', () => {
  for (const status of [500, 502, 503, 504]) assert.equal(
    isRetryableSearchError(new MTeamHttpError('remote_error', status)),
    true
  );
  assert.equal(isRetryableSearchError(new MTeamHttpError('rate_limited', 429)), true);
  assert.equal(isRetryableSearchError(new IntegrationValidationError('network', 'connection', {
    cause: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
  })
  ), true
  );
});

test('Retry-After supports seconds and HTTP dates, is respected, and never bypassed to fit the budget', async () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 0), 10_000);
  assert.equal(parseRetryAfter('invalid'), undefined);
  const runtime = clock();
  await retryMTeamSearch(async (attempt) => {
    if (attempt === 1) throw new MTeamHttpError('rate_limited', 429, 5000);
    return true;
  }, runtime
  );
  assert.deepEqual(runtime.waits, [5000]);
  let calls = 0;
  const tooLong = new MTeamHttpError('rate_limited', 429, 60_000);
  await assert.rejects(
    retryMTeamSearch(async () => { calls++; throw tooLong; }, clock()),
    (actual) => actual === tooLong
  );
  assert.equal(calls, 1);
});

test('total budget includes attempts and waits; configured source interval and jitter are respected', async () => {
  const runtime = clock();
  let calls = 0;
  await assert.rejects(retryMTeamSearch(async () => {
    calls++;
    runtime.advance(19_000);
    throw timeout();
  }, { ...runtime, minimumIntervalMs: 2500, random: () => 0.5 }
  ), /query timed out/
  );
  assert.equal(calls, 2);
  assert.deepEqual(runtime.waits, [2625]);
});

test('total deadline aborts hung work rather than waiting indefinitely', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(retryMTeamSearch(async (_attempt, _operationId, current) => {
    signal = current;
    return new Promise<never>(() => undefined);
  }, { budgetMs: 20 }
  ), /total time budget/
  );
  assert.equal(signal?.aborted, true);
});

test('retry failures retain diagnostics and correlation even when verbose is disabled', async () => {
  const errors: Record<string, unknown>[] = [];
  const infos: Record<string, unknown>[] = [];
  const trace = new AiTrace({ error: (value: Record<string, unknown>) => {
    return errors.push(value);
  }, info: (value: Record<string, unknown>) => {
    return infos.push(value);
  } }, { correlationId: 'query-123' }, 'private user text', 'query', false);
  await withAiTrace(trace, () => {
    return retryMTeamSearch(async (attempt) => {
      if (attempt < 3) throw new IntegrationValidationError('timeout', 'private user text', { cause: new Error('Bearer secret-token') });
      return 'ok';
    }, clock()
    );
  });
  assert.equal(infos.length, 0);
  assert.deepEqual(errors.map((entry) => entry.attempt), [1, 2]);
  assert.ok(errors.every((entry) => entry.correlationId === 'query-123'));
  assert.doesNotMatch(JSON.stringify(errors), /private user text|secret-token/);
  assert.match(JSON.stringify(errors), /stack|cause/);
});
