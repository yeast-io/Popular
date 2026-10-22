import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteClientWorker } from './remote-client.worker.js';
import type { RemoteClientService } from './remote-client.service.js';

test('worker scans at five seconds, prevents overlapping scans, and stop waits for active work', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let scans = 0;
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const service = {
    async retryNotifications() {
      scans++;
      await pending;
    },
  } as unknown as RemoteClientService;
  const worker = new RemoteClientWorker(service, { logger: { error() {} }, verbose: false });
  worker.start();
  worker.start();
  assert.equal(scans, 1);
  t.mock.timers.tick(10_000);
  assert.equal(scans, 1);
  complete();
  await worker.tick();
  t.mock.timers.tick(4999);
  assert.equal(scans, 1);
  t.mock.timers.tick(1);
  assert.equal(scans, 2);
  await worker.stop();
  t.mock.timers.tick(5000);
  assert.equal(scans, 2);
});
