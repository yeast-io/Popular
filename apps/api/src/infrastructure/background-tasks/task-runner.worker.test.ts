import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { TaskRunner } from './task-runner.worker.js';
import type { BackgroundTaskContext } from './background-task.types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('fixed rate preserves its clock, skips busy ticks, and start is idempotent', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const first = deferred();
  let calls = 0;
  const runner = new TaskRunner({ name: 'fixed-rate', intervalMs: 100,
    run: async () => {
      if (++calls === 1) await first.promise;
    } });
  t.after(() => runner.stop());
  runner.start();
  runner.start();
  assert.equal(calls, 1);
  t.mock.timers.tick(250);
  assert.equal(calls, 1);
  first.resolve();
  await runner.tick();
  t.mock.timers.tick(49);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
  await runner.stop();
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);
});

test('delayed first execution waits for the first timer and independent runners do not block each other', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const block = deferred();
  let delayedCalls = 0;
  const slow = new TaskRunner({ name: 'slow', intervalMs: 100, run: () => block.promise });
  const delayed = new TaskRunner({ name: 'delayed', intervalMs: 100, runOnStart: false,
    run: async () => { delayedCalls++; } });
  t.after(async () => {
    block.resolve();
    await Promise.all([slow.stop(), delayed.stop()]);
  });
  slow.start();
  delayed.start();
  t.mock.timers.tick(99);
  assert.equal(delayedCalls, 0);
  t.mock.timers.tick(1);
  assert.equal(delayedCalls, 1);
});

test('fixed delay schedules from settlement, not from the start of a slow run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = deferred();
  let calls = 0;
  const runner = new TaskRunner({ name: 'fixed-delay', intervalMs: 100, cadence: 'fixed-delay',
    run: async () => {
      if (++calls === 1) await first.promise;
    } });
  t.after(() => runner.stop());
  runner.start();
  t.mock.timers.tick(250);
  assert.equal(calls, 1);
  first.resolve();
  await runner.tick();
  t.mock.timers.tick(99);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
});

test('many wakeups merge into one follow-up while manual ticks only join the current run', async () => {
  const first = deferred();
  const second = deferred();
  const seen: string[] = [];
  const runner = new TaskRunner({ name: 'wake', intervalMs: 100,
    run: async ({ trigger }) => {
      seen.push(trigger);
      await (seen.length === 1 ? first.promise : second.promise);
    } });
  const active = runner.tick();
  assert.equal(runner.tick(), active);
  for (let index = 0; index < 100; index++) runner.wake();
  first.resolve();
  await active;
  assert.deepEqual(seen, ['manual', 'wake']);
  second.resolve();
  await runner.tick();
  await runner.stop();
});

test('stop aborts cooperatively, drops pending wakes, waits for real settlement, and blocks restart until drained', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const first = deferred();
  const contexts: BackgroundTaskContext[] = [];
  const runner = new TaskRunner({ name: 'shutdown', intervalMs: 100,
    run: async (context) => {
      contexts.push(context);
      if (contexts.length === 1) await first.promise;
    } });
  t.after(() => runner.stop());
  runner.start();
  runner.wake();
  let drained = false;
  const closing = runner.stop();
  assert.equal(runner.stop(), closing);
  void closing.then(() => {
    drained = true;
  });
  assert.equal(contexts[0]!.signal.aborted, true);
  runner.start();
  runner.wake();
  await runner.tick();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(drained, false);
  assert.equal(contexts.length, 1);
  first.resolve();
  await closing;
  runner.start();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[1]!.signal.aborted, false);
});

test('synchronous failure and failing error observers preserve both diagnostics and allow later execution', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const original = new Error('original failure', { cause: new Error('root failure') });
  const logs: unknown[] = [];
  let calls = 0;
  const runner = new TaskRunner({ name: 'recovery', intervalMs: 100, verbose: false,
    logger: { error: (line: unknown) => { logs.push(line); }, info: () => assert.fail('VERBOSE=false') },
    run: () => {
      if (++calls === 1) throw original;
      return Promise.resolve();
    },
    onError: (error) => {
      assert.equal(error, original);
      throw new Error('observer failure');
    } });
  t.after(() => runner.stop());
  runner.start();
  await runner.tick();
  assert.equal(logs.length, 2);
  assert.match(JSON.stringify(logs), /root failure/);
  assert.match(JSON.stringify(logs), /observer failure/);
  t.mock.timers.tick(100);
  assert.equal(calls, 2);
});

test('verbose diagnostics share an execution correlation and cancellation does not hide an unrelated error', async () => {
  const events: Array<Record<string, unknown>> = [];
  const block = deferred();
  const runner = new TaskRunner({ name: 'trace', intervalMs: 100, verbose: true,
    logger: { info: (line: Record<string, unknown>) => { events.push(line); },
      error: (line: Record<string, unknown>) => { events.push(line); } },
    run: async () => {
      await block.promise;
      throw new Error('failure during shutdown');
    } });
  const active = runner.tick();
  const closing = runner.stop();
  block.resolve();
  await Promise.all([active, closing]);
  assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);
  assert.equal(events[0]!.task, 'trace');
  assert.match(JSON.stringify(events), /failure during shutdown/);
});

test('rejects invalid timer configurations instead of silently clamping them', () => {
  for (const intervalMs of [0, -1, 0.5, Infinity, 2_147_483_648])
    assert.throws(() => new TaskRunner({ name: 'invalid', intervalMs, run: async () => {} }));
  assert.throws(() => new TaskRunner({ name: ' ', intervalMs: 100, run: async () => {} }));
});

test('intentional abort is quiet and a synchronous wake from user code is retained', async () => {
  let calls = 0;
  const block = deferred();
  const runner = new TaskRunner({ name: 'reentrant-wake', intervalMs: 100,
    logger: { error: () => assert.fail('intentional cancellation is not an error') },
    run: async ({ signal }) => {
      if (++calls === 1) {
        runner.wake();
        return;
      }
      await block.promise;
      signal.throwIfAborted();
    } });
  await runner.tick();
  assert.equal(calls, 2);
  const closing = runner.stop();
  block.resolve();
  await closing;
  runner.wake();
  await runner.tick();
  assert.equal(calls, 2);
});
