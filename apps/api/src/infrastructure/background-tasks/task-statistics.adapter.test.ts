import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { beginTaskStatistics } from './task-statistics.adapter.js';
import { TaskRunner } from './task-runner.worker.js';
import type { TaskStatisticEvent } from './background-task.types.js';

test('one start and one finish share an ID and a UTC counter day', async () => {
  const events: TaskStatisticEvent[] = [];
  const finish = beginTaskStatistics({ record: async (event) => {
    events.push(event);
  } }, 'example', 'job');
  finish('failure');
  finish('success');
  await setImmediate();
  assert.deepEqual(events.map((event) => event.phase), ['started', 'finished']);
  assert.equal(events[0]!.executionId, events[1]!.executionId);
  assert.equal(events[0]!.startedAt, events[1]!.startedAt);
  assert.equal(events[1]!.outcome, 'failure');
});

test('statistics failures do not fail or block task execution', async () => {
  let executions = 0;
  const runner = new TaskRunner({ name: 'example', intervalMs: 100,
    statistics: { record: async () => { throw new Error('Redis offline'); } },
    run: async () => { executions++; },
  });
  await runner.tick();
  await setImmediate();
  await runner.tick();
  assert.equal(executions, 2);
  await runner.stop();
});

test('poll execution records failures and cooperative shutdown separately', async () => {
  const events: TaskStatisticEvent[] = [];
  const statistics = { record: async (event: TaskStatisticEvent) => {
    events.push(event);
  } };
  const failed = new TaskRunner({ name: 'failed', intervalMs: 100, statistics,
    run: async () => { throw new Error('failure'); },
  });
  await failed.tick();
  await failed.stop();
  const cancelled = new TaskRunner({ name: 'cancelled', intervalMs: 100, statistics,
    run: ({ signal }) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  });
  cancelled.start();
  await cancelled.stop();
  await setImmediate();
  assert.deepEqual(events.filter((event) => event.phase === 'finished').map((event) => event.outcome), ['failure', 'cancelled']);
});
