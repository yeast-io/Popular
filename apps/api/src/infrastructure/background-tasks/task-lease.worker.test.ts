import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { TaskLease } from './task-lease.worker.js';

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('heartbeats and explicit checkpoints serialize, with no timer backlog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  let calls = 0;
  const lease = new TaskLease({ intervalMs: 100, renew: () => {
    calls++;
    return calls === 1 ? gate.promise : Promise.resolve(true);
  } });
  t.after(() => lease.stop());
  lease.start();
  lease.start();
  t.mock.timers.tick(100);
  await setImmediate();
  const checkpoint = lease.renew();
  assert.equal(checkpoint, lease.renew());
  t.mock.timers.tick(1000);
  assert.equal(calls, 1);
  gate.resolve(true);
  assert.equal(await checkpoint, true);
  await setImmediate();
  t.mock.timers.tick(99);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(calls, 2);
});

test('lease loss aborts work and stops further renewals', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const errors: unknown[] = [];
  const lease = new TaskLease({ intervalMs: 100, renew: async () => {
    calls++;
    return false;
  }, onError: (error) => errors.push(error) });
  lease.start();
  assert.equal(await lease.renew(), false);
  assert.equal(lease.signal.aborted, true);
  assert.match(String(lease.signal.reason.cause), /lease lost/);
  t.mock.timers.tick(1000);
  assert.equal(await lease.renew(), false);
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  await lease.stop();
});

test('renewal errors preserve the cause and stop waits for in-flight storage', async () => {
  const gate = deferred();
  const parent = new AbortController();
  const lease = new TaskLease({ intervalMs: 100, signal: parent.signal, renew: () => gate.promise });
  const checking = lease.renew();
  await setImmediate();
  parent.abort(new Error('shutdown'));
  assert.equal(lease.signal.reason, parent.signal.reason);
  let stopped = false;
  const closing = lease.stop().then(() => {
    stopped = true;
  });
  await setImmediate();
  assert.equal(stopped, false);
  gate.resolve(true);
  assert.equal(await checking, false);
  await closing;
  assert.equal(stopped, true);
  const failure = new Error('storage failed', { cause: new Error('connection lost') });
  const second = new TaskLease({ intervalMs: 100, renew: async () => {
    throw failure;
  }, onError: () => {} });
  assert.equal(await second.renew(), false);
  assert.equal(second.signal.reason.cause, failure);
  await second.stop();
});

test('deadline aborts cooperatively and waits for work rather than releasing early', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred();
  const lease = new TaskLease({ intervalMs: 100, renew: async () => true });
  let done = false;
  const execution = lease.withDeadline(200, async () => {
    await gate.promise;
    lease.signal.throwIfAborted();
  }).finally(() => {
    done = true;
  });
  const rejected = assert.rejects(execution, /deadline exceeded/);
  t.mock.timers.tick(200);
  assert.equal(lease.signal.aborted, true);
  assert.equal(done, false);
  gate.resolve(true);
  await rejected;
  await lease.stop();
});

test('finished work clears its deadline and pre-aborted parents never execute', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lease = new TaskLease({ intervalMs: 100, renew: async () => true });
  assert.equal(await lease.withDeadline(200, async () => 42), 42);
  t.mock.timers.tick(1000);
  assert.equal(lease.signal.aborted, false);
  await lease.stop();
  const parent = new AbortController();
  parent.abort();
  const cancelled = new TaskLease({ intervalMs: 100, signal: parent.signal, renew: async () => assert.fail() });
  cancelled.start();
  await assert.rejects(cancelled.withDeadline(100, async () => assert.fail()));
  assert.equal(await cancelled.renew(), false);
  await cancelled.stop();
});
