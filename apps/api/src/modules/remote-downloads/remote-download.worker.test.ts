import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { RemoteDownloadWorker } from './remote-download.worker.js';
import type { RemoteDownloadService } from './remote-download.service.js';
import type { RemoteDownloadCoordinator } from './remote-download-coordinator.service.js';

test('first sweep waits fifteen seconds and finishes before queued delivery begins', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const events: string[] = [];
  const worker = new RemoteDownloadWorker({
    options: { report: () => assert.fail('unexpected error') },
    sweep: async () => { events.push('sweep'); },
  } as unknown as RemoteDownloadService, {
    retryQueued: async () => { events.push('retry'); },
  } as unknown as RemoteDownloadCoordinator);
  t.after(() => worker.stop());
  worker.start();
  worker.start();
  t.mock.timers.tick(14_999);
  assert.deepEqual(events, []);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(events, ['sweep', 'retry']);
  await worker.stop();
  t.mock.timers.tick(15_000);
  assert.deepEqual(events, ['sweep', 'retry']);
});

test('shutdown drains an active sweep without beginning a new delivery phase', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release!: () => void;
  const sweep = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new RemoteDownloadWorker({ options: { report: () => assert.fail('unexpected error') },
    sweep: () => sweep,
  } as unknown as RemoteDownloadService, {
    retryQueued: async () => assert.fail('delivery after shutdown'),
  } as unknown as RemoteDownloadCoordinator);
  worker.start();
  t.mock.timers.tick(15_000);
  const closing = worker.stop();
  release();
  await closing;
});
