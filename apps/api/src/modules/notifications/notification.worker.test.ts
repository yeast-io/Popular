import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationWorker } from './notification.worker.js';

function fixture(enabled: boolean, fail = false, verbose = true) {
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
    { verbose, logger: { info: (line: Record<string, unknown>) => { events.push(String(line.stage)); }, error() {} } }
  );
  return { worker, events };
}

test('routine notification scans follow the switch without suppressing scan errors', async () => {
  for (const enabled of [false, true]) {
    const f = fixture(enabled);
    await f.worker.tick();
    await f.worker.stop();
    assert.deepEqual(f.events, enabled ? ['background-task.run.started', 'background-task.run.completed', 'background-task.finished'] : []);
  }
  const quiet = fixture(true, false, false);
  await quiet.worker.tick();
  await quiet.worker.stop();
  assert.deepEqual(quiet.events, []);
  const f = fixture(false, true, false);
  await f.worker.tick();
  await f.worker.stop();
  assert.deepEqual(f.events, ['SCAN_FAILED']);
});
