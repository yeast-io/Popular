import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixture, newDevice } from './fixture.mjs';
import { fingerprint } from '../../apps/api/src/modules/remote-downloads/remote-download.domain.ts';

test('PROCESS restart with file-backed test double: committed result before lost ACK repairs original projection', async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), 'popular-recovery-')
  );
  t.after(
    () => rm(root, { recursive: true, force: true })
  );
  const f = await createFixture();
  const live = await f.connect(
    await newDevice()
  );
  await f.prepare(
    live.peer
  );
  await f.grant(
    live.peer
  );
  const result = { commandId: 'command-1', executionId: 'execution-1', outcome: 'succeeded', evidence: f.evidence };
  const state = Object.fromEntries(
    ['accounts', 'devices', 'downloads', 'commands', 'receipts'].map((k) => [k, [...f.store[k]]])
  );
  state.request = { context: live.peer.session, agentMessageId: 'lost-result', agentDigest: fingerprint(
    result
  ), result };
  const file = join(root, 'ledger.json');
  await writeFile(file, JSON.stringify(state));
  const worker = fileURLToPath(new URL('./recovery-fixture.mjs', import.meta.url));
  const loader = fileURLToPath(new URL('../../apps/api/node_modules/tsx/dist/loader.mjs', import.meta.url));
  const crashed = spawnSync(
    process.execPath,
    ['--import', loader, worker, 'commit-crash', file],
    { encoding: 'utf8', timeout: 10_000 }
  );
  assert.equal(crashed.status, 86, crashed.stderr);
  const committed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(committed.commands[0][1].result.outcome, 'succeeded');
  assert.equal(committed.downloads[0][1].association, undefined);
  const restarted = spawnSync(
    process.execPath,
    ['--import', loader, worker, 'recover', file],
    { encoding: 'utf8', timeout: 10_000 }
  );
  assert.equal(restarted.status, 0, restarted.stderr);
  const recovered = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(recovered.commands[0][1].projected, true);
  assert.equal(recovered.downloads[0][1].association.executionId, 'execution-1');
  assert.equal(recovered.commands[0][1].grantExpiresAt, committed.commands[0][1].grantExpiresAt);
  assert.deepEqual(recovered.downloads[0][1].notificationTasks, ['preserve-notification']);
});
