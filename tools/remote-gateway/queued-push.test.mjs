import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, newDevice, message } from './fixture.mjs';

async function fixture() {
  const f = await createFixture();
  const device = await newDevice();
  const live = await f.connect(device);
  const s = live.peer.session;
  const input = { commandId: 'queued-command', downloadId: 'queued-download', ownerId: s.ownerId,
    deviceId: s.deviceId, authVersion: s.authVersion, deviceVersion: s.deviceVersion,
    source: 'mteam', resourceId: '42', correlationId: 'queue-trace' };
  f.store.downloads.set(input.downloadId, { ...input, tmdbId: 1, executionMode: 'remote', downloaderType: 'qbittorrent' });
  return { ...f, device, live, input };
}

test('queued push survives offline, reconnects automatically, and never extends its seven day deadline', async () => {
  const f = await fixture();
  await f.gateway.dropped(f.live.peer);
  await f.coordinator.enqueue(f.input);
  let c = await f.backend.get(f.input.commandId);
  const deadline = c.queueExpiresAt;
  assert.equal(deadline - c.createdAt, 7 * 86400000);
  assert.equal(c.lastErrorCode, 'DEVICE_OFFLINE');
  assert.equal(f.urlCalls(), 0);
  f.tick(61000);
  const reconnected = await f.connect(f.device, f.gateway, false);
  await f.coordinator.retryQueued();
  c = await f.backend.get(c.commandId);
  assert.equal(c.state, 'delivered');
  assert.equal(c.queueExpiresAt, deadline);
  assert.equal(c.deliverySessionId, reconnected.peer.session.sessionId);
  assert.ok(reconnected.sent.some((m) => m.command === '__add_download__'));
  f.tick(7 * 86400000);
  await f.backend.sweep();
  assert.equal(f.store.commands.size, 0);
  assert.equal(f.store.downloads.size, 0);
});

test('Agent online with unreachable/deleted downloader stays queued until a fresh reachable report', async () => {
  const f = await fixture();
  await f.gateway.message(f.live.peer, message('__agent_status__', {
    downloaderType: 'qbittorrent', instanceId: 'downloader-1', configured: false, reachable: false,
  }));
  await f.coordinator.enqueue(f.input);
  assert.equal((await f.backend.get(f.input.commandId)).lastErrorCode, 'DOWNLOADER_UNAVAILABLE');
  assert.equal(f.urlCalls(), 0);
  f.tick(61000);
  await f.connect(f.device, f.gateway, false);
  await f.coordinator.retryQueued();
  assert.equal((await f.backend.get(f.input.commandId)).state, 'delivered');
});

test('definite failure retries as a new delivery attempt, while ambiguous execution is never added twice', async () => {
  const f = await fixture();
  await f.coordinator.enqueue(f.input);
  const first = await f.backend.get(f.input.commandId);
  await f.backend.change(first.commandId, async (c) => ({ ...c, state: 'failed', executionId: 'old-execution',
    grantSessionId: c.deliverySessionId, grantExpiresAt: c.expiresAt,
    result: { commandId: c.commandId, executionId: 'old-execution', outcome: 'failed' }, projected: false }));
  f.tick(61000);
  await f.connect(f.device, f.gateway, false);
  await Promise.all([f.coordinator.retryQueued(), f.coordinator.retryQueued()]);
  const next = await f.backend.get(first.commandId);
  assert.equal(next.state, 'delivered');
  assert.equal(next.retryAttempt, 2);
  assert.notEqual(next.deliveryMessageId, first.deliveryMessageId);
  assert.equal(next.executionId, undefined);
  assert.equal(next.result, undefined);
  assert.equal(next.queueExpiresAt, first.queueExpiresAt);
  await f.backend.change(next.commandId, async (c) => ({ ...c, state: 'unknown', executionId: 'uncertain' }));
  f.tick(61000);
  await f.connect(f.device, f.gateway, false);
  const count = f.urlCalls();
  await f.coordinator.retryQueued();
  assert.equal(f.urlCalls(), count);
  assert.equal((await f.backend.get(first.commandId)).executionId, 'uncertain');
});

test('Gateway ages downloader reports independently of Agent connection renewals', async () => {
  const f = await fixture();
  const session = f.live.peer.session;
  const status = () => f.gateway.handleRpc('__get_device_status__', {
    ownerId: session.ownerId, deviceId: session.deviceId, authVersion: session.authVersion, deviceVersion: session.deviceVersion,
  }, {});
  assert.equal((await status()).isAgentDownloaderOnline, true);
  for (let i = 0; i < 3; i++) {
    f.tick(31000);
    await f.router.renew(session);
  }
  const stale = await status();
  assert.equal(stale.isAgentOnline, true);
  assert.equal(stale.isAgentDownloaderOnline, false);
  assert.equal(stale.agentStatus, null);
  await f.gateway.dropped(f.live.peer);
  assert.equal((await status()).isAgentOnline, false);
});

test('a pinned downloader is never replaced by a different instance; revoked bindings stop queue retry', async () => {
  const f = await fixture();
  await f.coordinator.enqueue(f.input);
  const original = await f.backend.get(f.input.commandId);
  f.tick(61000);
  const live = await f.connect(f.device, f.gateway, false);
  await f.gateway.message(live.peer, message('__agent_status__', {
    downloaderType: 'transmission', instanceId: 'replacement', configured: true, reachable: true,
  }));
  const count = f.urlCalls();
  await f.coordinator.retryQueued();
  const blocked = await f.backend.get(f.input.commandId);
  assert.equal(blocked.state, 'failed');
  assert.equal(blocked.lastErrorCode, 'DOWNLOADER_INSTANCE_MISMATCH');
  assert.deepEqual(blocked.targetDownloader, original.targetDownloader);
  assert.equal(f.urlCalls(), count);
  f.store.devices.get(f.device.deviceId).status = 'unbound';
  await f.backend.sweep();
  assert.equal((await f.backend.get(f.input.commandId)).state, 'cancelled');
  f.tick(7 * 86400000);
  await f.backend.sweep();
  assert.equal(f.store.commands.size, 0);
});

test('closing a queued command during an in-flight status query cannot revive it', async () => {
  const f = await fixture();
  await f.gateway.dropped(f.live.peer);
  await f.coordinator.enqueue(f.input);
  f.tick(61000);
  await f.connect(f.device, f.gateway, false);
  const original = f.coordinator.gateway.call;
  f.coordinator.gateway.call = async (...args) => {
    const response = await original(...args);
    if (args[0] === '__get_device_status__') await f.backend.close(f.input.commandId, f.input.ownerId, 'close-race');
    return response;
  };
  await f.coordinator.retryQueued();
  assert.equal((await f.backend.get(f.input.commandId)).state, 'closed');
  assert.equal(f.urlCalls(), 0);
});

test('per-user site/torrent daily limits stop dispatch for 24h, survive repeat intents and resume without extending queue lifetime', async () => {
  const { RpcError } = await import('../../packages/contract/dist/helper-gateway/socket-rpc.service.js');
  const f = await fixture();
  let calls = 0;
  f.backend.options.torrent = async () => {
    calls++;
    throw new RpcError('RESOURCE_TORRENT_DAILY_LIMIT', 'not_applied');
  };
  await f.coordinator.enqueue(f.input);
  const first = await f.backend.get(f.input.commandId);
  assert.equal(first.lastErrorCode, 'RESOURCE_TORRENT_DAILY_LIMIT');
  assert.equal(first.nextAttemptAt - first.limitDetectedAt, 86400000);
  assert.equal(first.executionId, undefined);
  assert.equal(calls, 1);
  assert(!f.live.sent.some((m) => m.command === '__add_download__'));
  const snapshot = await f.backend.handle('__list_queued_downloads__', { context: f.live.peer.session });
  assert.equal(snapshot.items[0].reason, 'torrent_daily_limit');
  assert.equal(snapshot.items[0].nextAttemptAt, first.nextAttemptAt);
  assert.equal(snapshot.items[0].limitDetectedAt, first.limitDetectedAt);
  assert.equal(snapshot.items[0].lastAttemptAt, first.lastAttemptAt);

  for (let i = 0; i < 5; i++) {
    f.tick(61000);
    await f.coordinator.enqueue(f.input);
    await f.coordinator.retryQueued();
    await f.backend.handle('__list_queued_downloads__', { context: f.live.peer.session });
  }
  assert.equal(calls, 1);
  assert.equal((await f.backend.get(first.commandId)).nextAttemptAt, first.nextAttemptAt);

  // Another command and another device cannot bypass the same user's resource cooldown.
  const same = { ...f.input, commandId: 'another-command', downloadId: 'another-download' };
  f.store.downloads.set(same.downloadId, { ...same, tmdbId: 2, executionMode: 'remote' });
  await f.coordinator.enqueue(same);
  assert.equal((await f.backend.get(same.commandId)).nextAttemptAt, first.nextAttemptAt);
  assert.equal(calls, 1);
  const originalScope = { ownerId: f.input.ownerId, source: 'mteam', resourceId: '42' };
  assert(await f.store.resourceDownloadLimit(originalScope, first.limitDetectedAt));
  assert.equal(await f.store.resourceDownloadLimit({ ...originalScope, ownerId: 'another-user' }, first.limitDetectedAt), null);
  assert.equal(await f.store.resourceDownloadLimit({ ...originalScope, source: 'hdarea' }, first.limitDetectedAt), null);
  assert.equal(await f.store.resourceDownloadLimit({ ...originalScope, resourceId: '43' }, first.limitDetectedAt), null);

  f.tick(first.nextAttemptAt - f.backend.now());
  await f.connect(f.device, f.gateway, false);
  f.backend.options.torrent = async () => {
    calls++;
    return { url: 'https://tracker.invalid/file?passkey=SECRET', torrentHash: 'a'.repeat(40) };
  };
  await f.coordinator.retryQueued();
  const resumed = await f.backend.get(first.commandId);
  assert.equal(resumed.state, 'delivered');
  assert.equal(resumed.commandId, first.commandId);
  assert.equal(resumed.queueExpiresAt, first.queueExpiresAt);
  assert.equal(resumed.lastErrorCode, '');
  assert.equal(resumed.limitDetectedAt, undefined);
  const after = calls;
  await f.coordinator.retryQueued();
  assert.equal(calls, after);
});

test('cooldown applies before token generation across users/sites/resources, including future site adapters', async () => {
  const f = await fixture();
  const now = f.backend.now();
  await f.store.saveResourceDownloadLimit({ ownerId: f.input.ownerId, source: 'mteam', resourceId: '42',
    kind: 'torrent_daily_limit', detectedAt: now, retryAt: now + 86400000 });
  let calls = 0;
  f.backend.options.torrent = async () => {
    calls++;
    return { url: 'https://tracker.invalid/file', torrentHash: 'a'.repeat(40) };
  };
  const session = f.live.peer.session;
  for (const [ownerId, source, resourceId, expected] of [
    [f.input.ownerId, 'mteam', '42', false],
    [f.input.ownerId, 'mteam', '43', true],
    [f.input.ownerId, 'hdarea', '42', true],
    ['owner-2', 'mteam', '42', true],
  ]) {
    const context = { ...session, ownerId, deviceId: `${ownerId}-device` };
    f.store.accounts.set(ownerId, { ownerId, keyDigest: `${ownerId}-key`, authVersion: 1, active: true });
    f.store.devices.set(context.deviceId, { ...context, keys: f.device.keys, status: 'bound' });
    const id = `${ownerId}-${source}-${resourceId}`;
    const input = { ...f.input, ownerId, source, resourceId, deviceId: context.deviceId, commandId: id, downloadId: id };
    f.store.downloads.set(id, { ...input, tmdbId: 3, executionMode: 'remote' });
    await f.backend.register(input, context, true);
    const before = calls;
    const prepare = () => f.backend.handle('__prepare_delivery__', { context, commandId: id });
    if (expected) await prepare();
    else await assert.rejects(prepare(), { code: 'RESOURCE_TORRENT_DAILY_LIMIT' });
    assert.equal(calls - before, Number(expected));
  }
  const next = { ownerId: 'owner-3', source: 'future-site', resourceId: '42' };
  await f.store.saveResourceDownloadLimit({ ...next, kind: 'torrent_daily_limit', detectedAt: now, retryAt: now + 86400000 });
  assert.equal((await f.store.resourceDownloadLimit(next, now)).retryAt, now + 86400000);
});

test('recurring site limits restart the 24h cooldown and never extend an expiring task', async () => {
  const { RpcError } = await import('../../packages/contract/dist/helper-gateway/socket-rpc.service.js');
  const f = await fixture();
  let calls = 0;
  f.backend.options.torrent = async () => {
    calls++;
    throw new RpcError('RESOURCE_TORRENT_DAILY_LIMIT', 'not_applied');
  };
  await f.coordinator.enqueue(f.input);
  const first = await f.backend.get(f.input.commandId);
  f.tick(86400000);
  await f.connect(f.device, f.gateway, false);
  await f.coordinator.retryQueued();
  const again = await f.backend.get(first.commandId);
  assert.equal(calls, 2);
  assert.equal(again.nextAttemptAt, first.nextAttemptAt + 86400000);
  assert.equal(again.queueExpiresAt, first.queueExpiresAt);
  f.tick(first.queueExpiresAt - f.backend.now());
  await f.backend.sweep();
  await f.coordinator.retryQueued();
  assert.equal(calls, 2);
  assert.equal(f.store.commands.has(first.commandId), false);
});

test('a mismatched user cooldown cannot be applied to another user command', async () => {
  const f = await fixture();
  await f.coordinator.enqueue(f.input);
  const before = await f.backend.get(f.input.commandId);
  await assert.rejects(f.backend.deferForResourceLimit(f.input.commandId, {
    ownerId: 'other-user', source: f.input.source, resourceId: f.input.resourceId,
    kind: 'torrent_daily_limit', detectedAt: f.backend.now(), retryAt: f.backend.now() + 86400000,
  }), { code: 'RESOURCE_LIMIT_SCOPE_MISMATCH' });
  assert.deepEqual(await f.backend.get(f.input.commandId), before);
});
