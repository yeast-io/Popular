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
    },
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
        events.push(String(line.event));
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
      enabled,
    );
    service.start();
    await service.stop();
    assert.deepEqual(events, enabled ? ['external_usage_scan_started', 'external_usage_scan_completed'] : []);
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
    },
  );
  service.start();
  await service.stop();
  assert.equal(errors, 1);
});
