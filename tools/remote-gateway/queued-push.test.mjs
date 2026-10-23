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
