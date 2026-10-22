// Public-key Agent protocol simulator. TEST DOUBLE storage and downloader, no network or .env.
import { createFixture, newDevice, message } from './fixture.mjs';

const f = await createFixture();
const device = await newDevice();
const live = await f.connect(device);
await f.prepare(live.peer);
await f.grant(live.peer);
await f.gateway.message(live.peer, message('__command_result__', { commandId: 'command-1', executionId: 'execution-1', outcome: 'succeeded', evidence: f.evidence }));
console.log(JSON.stringify({ mode: 'simulated-storage-and-downloader', messages: live.sent.map((m) => m.command),
  result: await f.coordinator.query('command-1', 'owner-1'), notificationFieldsPreserved: f.store.downloads.get('download-command-1').notificationTasks.length === 1 }, null, 2));
