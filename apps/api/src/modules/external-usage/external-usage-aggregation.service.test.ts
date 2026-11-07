import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ExternalUsageAggregationService } from './external-usage-aggregation.service.js';

test('stop waits for an active database aggregation before connections may close', async () => {
  let finish!: () => void;
  const active = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = new ExternalUsageAggregationService(
    {
      rebuildDaily: () => {
        return active;
      },
    },
    {
      error: () => {
        return undefined;
      },
    }
  );
  service.start();
  let stopped = false;
  const closing = service.stop().then(() => {
    stopped = true;
  });
  await setImmediate();
  assert.equal(stopped, false);
  finish();
  await closing;
  assert.equal(stopped, true);
});

test('routine aggregation scans follow the switch while errors remain visible', async () => {
  for (const enabled of [false, true]) {
    const events: string[] = [];
    const logger = {
      info: (line: Record<string, unknown>) => {
        events.push(String(line.stage));
      },
      error: () => {
        events.push('error');
      },
    };
    const service = new ExternalUsageAggregationService(
      {
        rebuildDaily: async () => {
          return undefined;
        },
      },
      logger,
      undefined,
      undefined,
      enabled
    );
    service.start();
    await service.stop();
    assert.deepEqual(events, enabled ? ['background-task.run.started', 'background-task.run.completed', 'background-task.finished'] : []);
  }
  let errors = 0;
  const service = new ExternalUsageAggregationService(
    {
      rebuildDaily: async () => {
        throw new Error('database unavailable');
      },
    },
    {
      error: () => {
        errors++;
      },
    }
  );
  service.start();
  await service.stop();
  assert.equal(errors, 1);
});

test('startup uses the retention window while periodic runs use the recent window, including after restart', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const windows: Date[] = [];
  const now = new Date('2026-11-07T12:00:00Z');
  const service = new ExternalUsageAggregationService({ rebuildDaily: async (since) => {
    windows.push(since);
  } },
  { error() {} }, 100, () => now);
  t.after(() => service.stop());
  service.start();
  service.start();
  await setImmediate();
  assert.equal(windows.length, 1);
  assert.ok(windows[0]! < new Date('2026-11-06T00:00:00Z'));
  t.mock.timers.tick(100);
  await setImmediate();
  assert.equal(windows[1]!.toISOString(), '2026-11-06T00:00:00.000Z');
  await service.stop();
  service.start();
  await setImmediate();
  assert.equal(windows[2]!.getTime(), windows[0]!.getTime());
});
