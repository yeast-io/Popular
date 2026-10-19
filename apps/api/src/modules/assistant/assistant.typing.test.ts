import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AiTrace } from '../../infrastructure/logging/ai-trace.js';
import { startTyping } from './assistant.typing.js';

test('typing refreshes every four seconds, never overlaps and stops idempotently', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: boolean[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stop = startTyping(async active => {
    calls.push(active);
    if (calls.length === 1) await gate;
  }, new AbortController().signal, new AiTrace(undefined, {}, '', 'typing', false));
  t.mock.timers.tick(12_000);
  assert.deepEqual(calls, [true]);
  release();
  await setImmediate();
  t.mock.timers.tick(4_000);
  await setImmediate();
  assert.deepEqual(calls, [true, true]);
  await stop();
  await stop();
  t.mock.timers.tick(12_000);
  assert.deepEqual(calls, [true, true, false]);
});

test('abort cancels an in-flight typing update before sending paused', async () => {
  const controller = new AbortController();
  const calls: boolean[] = [];
  const stop = startTyping(async (active, signal) => {
    calls.push(active);
    if (active) await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, controller.signal, new AiTrace(undefined, {}, '', 'typing', false));
  controller.abort();
  await stop();
  assert.deepEqual(calls, [true, false]);
});

test('presence errors preserve diagnostics even with verbose disabled and do not reject cleanup', async () => {
  const logs: Array<Record<string, unknown>> = [];
  const trace = new AiTrace({ error: (fields: Record<string, unknown>) => { logs.push(fields); } }, { correlationId: 'job-1' }, '', 'typing', false);
  const stop = startTyping(async () => { throw new Error('presence unavailable', { cause: new Error('socket closed') }); },
    new AbortController().signal, trace);
  await setImmediate();
  await stop();
  assert.equal(logs.length, 2);
  assert.ok(logs.every(row => row.correlationId === 'job-1' && row.stage === 'assistant.typing.send'));
  assert.match(JSON.stringify(logs), /socket closed/);
  assert.match(JSON.stringify(logs), /stack/);
});
