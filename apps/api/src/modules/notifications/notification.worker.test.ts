import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationWorker } from './notification.worker.js';

function fixture(enabled: boolean, fail = false) {
  const events: string[] = [];
  const service = {
    store: {
      claimIntent: async () => {
        if (fail) throw new Error('database unavailable');
        return null;
      },
      claimTask: async () => null,
    },
  };
  const worker = new NotificationWorker(
    service as never,
    {} as never,
    {} as never,
    'zh-CN',
    'http://localhost',
    (event) => {
      events.push(event);
    },
    undefined,
    undefined,
    enabled,
  );
  return { worker, events };
}

test('routine notification scans follow the switch without suppressing scan errors', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(enabled);
    await f.worker.tick();
    await f.worker.stop();
    assert.deepEqual(f.events, enabled ? ['SCAN_STARTED', 'SCAN_COMPLETED'] : []);
  }
  const f = fixture(false, true);
  await f.worker.tick();
  await f.worker.stop();
  assert.deepEqual(f.events, ['SCAN_FAILED']);
});
