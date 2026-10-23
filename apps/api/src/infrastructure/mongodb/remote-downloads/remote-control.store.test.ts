import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { createUserModel } from '../users/user.schema.js';
import { createRemoteDeviceModel } from '../remote-clients/remote-device.schema.js';
import { createMovieDownloadModel } from '../downloads/movie-download.schema.js';
import { createRemoteCommandModels } from './remote-command.schema.js';
import { MongoRemoteControlStore } from './remote-control.store.js';
import type { CommandRecord, DeviceKeys } from '@movie-hub/contract';
import { fingerprint } from '../../../modules/remote-downloads/remote-download.domain.js';
import { MongoMovieDownloadStore } from '../downloads/movie-download.store.js';

test('an unrelated unique-index failure retains the original MongoDB error and cause details', async () => {
  const duplicate = Object.assign(new Error('duplicate downloadId'), { code: 11000, keyPattern: { downloadId: 1 } });
  const c: CommandRecord = { commandId: 'new-command', downloadId: 'download', ownerId: 'owner',
    deviceId: 'device', authVersion: 1, deviceVersion: 1, source: 'mteam', resourceId: '991', correlationId: 'trace',
    digest: 'digest', revision: 0, state: 'accepted', createdAt: 1, expiresAt: 2,
    deliverySessionId: 'session', deliveryMessageId: 'message' };
  const store = new MongoRemoteControlStore({} as never, {} as never, {
    updateOne: () => ({ exec: async () => ({ modifiedCount: 0 }) }),
    findOne: () => ({ lean: () => ({ exec: async () => ({ remoteRequest: c }) }) }),
  } as never, { commands: {
    findOne: () => ({ lean: () => ({ exec: async () => null }) }),
    async create() { throw duplicate; },
  } } as never);
  await assert.rejects(store.createCommand(c), (error: unknown) => error === duplicate);
});

test('replaced commands cannot project results or progress into a redownload, while its new sequence starts at one', async () => {
  const association = { commandId: 'new-command', executionId: 'new-execution', deviceId: 'device',
    authVersion: 1, deviceVersion: 1, downloaderType: 'transmission' as const, instanceId: 'nas',
    torrentHash: 'a'.repeat(40), taskId: 'new-task', marker: 'popular-new-execution' };
  let writes = 0;
  const row = { remoteRequest: { commandId: 'new-command' }, remoteAssociation: association, status: 'downloading' };
  const downloads = {
    findOne(filter: Record<string, unknown>) {
      const commandFilter = filter['remoteRequest.commandId'] ?? (filter.$or ? { $ne: 'old-command' } : undefined);
      const matches = typeof commandFilter === 'object'
        ? (commandFilter as { $ne: string }).$ne !== row.remoteRequest.commandId
        : commandFilter === row.remoteRequest.commandId;
      const query = { select: (_fields: string) => query, lean: () => ({ exec: async () => matches ? row : null }) };
      return query;
    },
    updateOne(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
      assert.equal(filter['remoteRequest.commandId'], 'new-command');
      assert.equal(filter['remoteAssociation.executionId'], 'new-execution');
      assert.deepEqual(filter.$or, [{ remoteStatusSequence: { $exists: false } }, { remoteStatusSequence: { $lt: 1 } }]);
      assert.equal(update.$set.status, 'downloading');
      assert.equal(update.$set.progress, 10);
      writes++;
      return { exec: async () => ({ modifiedCount: 1 }) };
    },
  };
  const store = new MongoRemoteControlStore({} as never, {} as never, downloads as never, { commands: { updateOne: () => ({ exec: async () => ({ modifiedCount: 1 }) }) } } as never);
  const old: CommandRecord = { commandId: 'old-command', downloadId: 'download', ownerId: 'owner',
    deviceId: 'device', authVersion: 1, deviceVersion: 1, source: 'mteam', resourceId: '991', correlationId: 'trace',
    digest: 'digest', revision: 99, state: 'succeeded', createdAt: 1, expiresAt: 2,
    deliverySessionId: 'session', deliveryMessageId: 'message', executionId: 'old-execution' };
  const status = { commandId: old.commandId, executionId: 'old-execution', evidence: association, sequence: 999,
    state: 'deleted' as const, progress: 0.5, downloadedBytes: 50, totalBytes: 100, downloadSpeed: 0, uploadSpeed: 0 };
  assert.equal(await store.projectResult(old), false);
  assert.equal(await store.applyStatus(old, status), 'stale');
  assert.equal(writes, 0);
  assert.equal(await store.applyStatus({ ...old, commandId: 'new-command', executionId: 'new-execution' },
    { ...status, commandId: 'new-command', executionId: 'new-execution', sequence: 1, state: 'downloading', progress: 0.1 }), 'applied');
  assert.equal(writes, 1);
});

test(
  'REAL standalone Mongo (opt-in): concurrent binding, durable CAS, original projection and out-of-order status',
  {
    skip: !process.env.REMOTE_GATEWAY_TEST_MONGODB_URI,
    timeout: 30_000,
  },
  async (t) => {
    const testDatabaseName = 'popular_gateway_test_' + randomUUID().replaceAll('-', '');
    const connection = await createConnection(process.env.REMOTE_GATEWAY_TEST_MONGODB_URI!, {
      dbName: testDatabaseName,
      serverSelectionTimeoutMS: 5000,
    }
    ).asPromise();
    assert.equal(connection.name, testDatabaseName);
    t.after(async () => {
      assert.equal(connection.name, testDatabaseName, 'Refuse cleanup outside this test run’s isolated database');
      await connection.dropDatabase();
      await connection.close();
    });
    const users = createUserModel(connection);
    const devices = createRemoteDeviceModel(connection);
    const downloads = createMovieDownloadModel(connection);
    const models = createRemoteCommandModels(connection);
    await Promise.all([users, devices, downloads, models.commands, models.receipts].map((m) => m.init()));
    const user = await users.create({
      email: 'gateway-test@example.invalid',
      displayName: 'test',
      remoteDeviceLimit: 1,
      rcck: { keyDigest: 'a'.repeat(64), active: true, authVersion: 1 },
    }
    );
    const store = new MongoRemoteControlStore(users, devices, downloads, models);
    const keys = (id: string): DeviceKeys => {
      return { signingKey: { kty: 'OKP', crv: 'Ed25519', x: id }, encryptionKey: { kty: 'RSA', n: id, e: 'AQAB' } };
    };
    const bound = await Promise.allSettled([
      store.bind('a'.repeat(64), 1, 'bind-1', keys('one')),
      store.bind('a'.repeat(64), 1, 'bind-2', keys('two')),
    ]
    );
    assert.equal(bound.filter((r) => r.status === 'fulfilled').length, 1);
    const authorization = bound.find((r) => r.status === 'fulfilled')!;
    assert.equal(authorization.status, 'fulfilled');
    if (authorization.status !== 'fulfilled') return;
    const a = authorization.value!;
    const download = await downloads.create({
      ownerId: user._id,
      tmdbId: 1,
      sourceProvider: 'mteam',
      sourceReleaseId: 'resource-1',
      provider: 'qbittorrent',
      lookupTag: 'original',
      status: 'submitting',
      executionMode: 'remote',
      notificationTask: {
        id: 'notification-1',
        epoch: 1,
        channels: [{ channel: 'telegram', notified: false }],
        nextRunAt: new Date(),
      },
    }
    );
    const input = {
      commandId: 'command-1',
      downloadId: download._id.toString(),
      ownerId: user._id.toString(),
      deviceId: a.deviceId!,
      authVersion: 1,
      deviceVersion: 1,
      source: 'mteam',
      resourceId: 'resource-1',
      correlationId: 'trace-1',
    };
    const c: CommandRecord = {
      ...input,
      revision: 0,
      digest: fingerprint(input),
      state: 'accepted',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
      deliverySessionId: 'session-1',
      deliveryMessageId: 'delivery-1',
    };
    await store.createCommand(c);
    await models.commands.deleteOne({ commandId: c.commandId }); // Crash between original intent and command ledger.
    await downloads.updateOne({ _id: download._id }, { $set: { remoteCommandRegistered: false } });
    await store.recoverCommands();
    const restored = await store.createCommand({
      ...c,
      expiresAt: c.expiresAt + 100000,
      deliverySessionId: 'new-session',
    }
    );
    assert.equal(restored.expiresAt, c.expiresAt);
    assert.equal(restored.deliverySessionId, c.deliverySessionId);
    const evidence = {
      downloaderType: 'qbittorrent' as const,
      instanceId: 'target-1',
      taskId: 'task-1',
      torrentHash: 'b'.repeat(40),
      marker: 'popular-execution-1',
    };
    const success: CommandRecord = {
      ...c,
      revision: 1,
      state: 'succeeded',
      executionId: 'execution-1',
      result: { commandId: c.commandId, executionId: 'execution-1', outcome: 'succeeded', evidence },
    };
    const updates = await Promise.all([
      store.compareCommand(c, success),
      store.compareCommand(c, { ...success, state: 'failed' }),
    ]
    );
    assert.equal(updates.filter(Boolean).length, 1);
    assert.equal(await store.projectResult(success), true);
    assert.equal(await store.projectResult(success), true);
    const status = {
      commandId: c.commandId,
      executionId: 'execution-1',
      evidence,
      sequence: 2,
      state: 'downloading' as const,
      progress: 0.5,
      downloadedBytes: 50,
      totalBytes: 100,
      downloadSpeed: 10,
      uploadSpeed: 0,
    };
    assert.equal(await store.applyStatus(success, status), 'applied');
    assert.equal(await store.applyStatus(success, { ...status, sequence: 1, progress: 0.1 }), 'stale');
    const persisted = await downloads.findById(download._id).lean();
    assert.equal(persisted!.progress, 50);
    assert.equal(persisted!.notificationTask!.id, 'notification-1');
    assert.equal(await store.applyStatus(success, { ...status, sequence: 3, state: 'deleted' }), 'applied');
    const movieStore = new MongoMovieDownloadStore(downloads);
    const missing = (await movieStore.findByRelease(c.ownerId, 1, 'resource-1'))!;
    const requeues = await Promise.all(Array.from({ length: 5 }, () => movieStore.claimMissing(missing, 'qbittorrent', undefined, 'Agent', {
      deviceId: c.deviceId, authVersion: 1, deviceVersion: 1, correlationId: randomUUID(),
    })));
    assert.equal(requeues.filter((claim) => claim.claimed).length, 1);
    assert.equal(new Set(requeues.map((claim) => claim.record.remoteCommandId)).size, 1);
    const fresh = requeues[0]!.record;
    assert.equal(fresh.id, missing.id);
    assert.notEqual(fresh.remoteCommandId, c.commandId);
    assert.equal(fresh.status, 'submitting');
    await store.recoverCommands();
    assert.equal(await models.commands.countDocuments({ downloadId: fresh.id }), 2);
    assert.ok(await store.command(c.commandId));
    assert.equal((await downloads.findById(download._id).lean())!.remoteCommandRegistered, true);
    assert.equal(await store.projectResult({ ...success, revision: 100 }), false);
    assert.equal(await store.applyStatus(success, { ...status, sequence: 999 }), 'stale');
    const next = await store.createCommand({ ...c, commandId: fresh.remoteCommandId!,
      correlationId: fresh.remoteCorrelationId!, digest: fingerprint({ ...input,
        commandId: fresh.remoteCommandId!, correlationId: fresh.remoteCorrelationId! }) });
    const nextEvidence = { ...evidence, taskId: 'task-2', marker: 'popular-execution-2' };
    const nextSuccess: CommandRecord = { ...next, revision: 1, state: 'succeeded', executionId: 'execution-2',
      result: { commandId: next.commandId, executionId: 'execution-2', outcome: 'succeeded', evidence: nextEvidence } };
    assert.equal(await store.projectResult(nextSuccess), true);
    assert.equal(await store.applyStatus(nextSuccess, { ...status, commandId: next.commandId,
      executionId: 'execution-2', evidence: nextEvidence, sequence: 1, progress: 0.1 }), 'applied');
    const redownloaded = await downloads.findById(download._id).lean();
    assert.equal(redownloaded!.progress, 10);
    assert.equal(redownloaded!.status, 'downloading');
    assert.equal(redownloaded!.remoteAssociation!.executionId, 'execution-2');
    assert.equal(await store.applyStatus(success, { ...status, sequence: 1000, state: 'deleted' }), 'stale');
    assert.equal((await downloads.findById(download._id).lean())!.status, 'downloading');
    assert.equal(await store.applyStatus(nextSuccess, { ...status, commandId: next.commandId,
      executionId: 'execution-2', evidence: nextEvidence, sequence: 2, state: 'deleted' }), 'applied');
    const deleted = (await movieStore.findByRelease(c.ownerId, 1, 'resource-1'))!;
    const ended = await downloads.findById(download._id).lean();
    assert.ok(ended!.expiresAt);
    assert.ok((await store.command(next.commandId))!.retiredAt);
    // Later snapshots cannot revive a deletion even before the record is reassigned.
    assert.equal(await store.applyStatus(nextSuccess, { ...status, commandId: next.commandId,
      executionId: 'execution-2', evidence: nextEvidence, sequence: 3, state: 'downloading' }), 'stale');
    assert.equal((await downloads.findById(download._id).lean())!.status, 'missing');
    const localClaims = await Promise.all(Array.from({ length: 5 }, () =>
      movieStore.claimMissing(deleted, 'transmission', 'public-transmission', 'Public Transmission')));
    assert.equal(localClaims.filter((claim) => claim.claimed).length, 1);
    const local = localClaims[0]!.record;
    assert.equal(local.id, deleted.id);
    assert.equal(local.executionMode, 'local');
    assert.equal(local.downloaderInstanceId, 'public-transmission');
    assert.equal(local.remoteCommandId, undefined);
    assert.equal(local.lastErrorCode, undefined);
    assert.notEqual(local.lookupTag, deleted.lookupTag);
    assert.equal(await store.applyStatus(nextSuccess, { ...status, commandId: next.commandId,
      executionId: 'execution-2', evidence: nextEvidence, sequence: 4, state: 'deleted' }), 'stale');
    await movieStore.markMissing(local.id, new Date());
    const localMissing = (await movieStore.findByRelease(c.ownerId, 1, 'resource-1'))!;
    const agentClaim = await movieStore.claimMissing(localMissing, 'qbittorrent', undefined, 'Agent B', {
      deviceId: 'different-device', authVersion: 1, deviceVersion: 1, correlationId: randomUUID(),
      targetDownloader: { downloaderType: 'qbittorrent', instanceId: 'new-nas' },
    });
    assert.equal(agentClaim.claimed, true);
    assert.equal(agentClaim.record.remoteDeviceId, 'different-device');
    assert.equal(agentClaim.record.downloaderInstanceId, undefined);
    assert.equal(agentClaim.record.executionMode, 'remote');
    const queueNow = Date.now();
    const queuedParents: Array<Record<string, unknown>> = [];
    const queuedCommands: CommandRecord[] = [];
    for (let index = 0; index < 56; index++) {
      const id = new Types.ObjectId();
      const commandId = `queue-${String(index).padStart(3, '0')}`;
      queuedParents.push({ _id: id, ownerId: user._id, tmdbId: 10000, sourceProvider: 'mteam',
        sourceReleaseId: String(1000 + index), lookupTag: commandId, executionMode: 'remote', status: 'submitting', progress: 0,
        remoteRequest: { commandId, ...(index === 0 ? { displayTitle: '排队资源 · Pending release' } : {}) } });
      queuedCommands.push({ ...c, commandId, downloadId: id.toString(), resourceId: String(1000 + index),
        queueExpiresAt: index === 53 ? queueNow - 1 : queueNow + 604800000,
        deviceId: index === 54 ? 'another-device' : c.deviceId,
        state: index === 55 ? 'succeeded' : index === 1 ? 'unknown' : 'accepted',
        createdAt: queueNow - 1000, lastErrorCode: index === 0 ? 'DOWNLOADER_UNAVAILABLE' : '' });
    }
    await downloads.insertMany(queuedParents);
    await models.commands.insertMany(queuedCommands);
    await connection.collection('movies').insertOne({ tmdbId: 10000, originalTitle: 'Fallback movie title' });
    const queueContext = { ownerId: c.ownerId, deviceId: c.deviceId, authVersion: 1, deviceVersion: 1,
      sessionId: 'queue-session', instanceId: 'gateway' };
    const firstPage = await store.queued(queueContext, queueNow);
    assert.equal(firstPage.total, 53);
    assert.equal(firstPage.items.length, 50);
    assert.equal(firstPage.items[0]!.title, '排队资源 · Pending release');
    assert.equal(firstPage.items[0]!.reason, 'downloader_unavailable');
    assert.equal(firstPage.items[1]!.reason, 'verifying');
    assert.equal(firstPage.items[1]!.title, 'Fallback movie title');
    const lastPage = await store.queued(queueContext, queueNow, firstPage.nextCursor!);
    assert.equal(lastPage.total, 53);
    assert.equal(lastPage.items.length, 3);
    assert.equal(lastPage.nextCursor, null);
    assert.equal(new Set([...firstPage.items, ...lastPage.items].map((item) => item.commandId)).size, 53);
    assert.equal((await store.queued({ ...queueContext, ownerId: 'another-owner' }, queueNow)).total, 0);
    assert.equal((await store.queued({ ...queueContext, authVersion: 2 }, queueNow)).total, 0);
    assert.equal((await store.queued(queueContext, queueNow + 604800001)).total, 0);
    assert.equal(await store.remember('event', 'digest'), true);
    assert.equal(await store.remember('event', 'other'), false);
    await devices.updateOne({ deviceId: a.deviceId }, { $set: { status: 'unbound', deviceVersion: 2 } });
    assert.equal(
      await store.validate({
        ownerId: c.ownerId,
        deviceId: c.deviceId,
        authVersion: 1,
        deviceVersion: 1,
        sessionId: 'session',
        instanceId: 'gateway',
      }
      ),
      null
    );
  });

test('queue cleanup deletes expired parents before commands and preserves confirmed success', async () => {
  const calls: Array<{ kind: string; filter: unknown }> = [];
  const deletion = (kind: string) => (filter: unknown) => {
    calls.push({ kind, filter });
    return { exec: async () => ({ deletedCount: 1 }) };
  };
  const store = new MongoRemoteControlStore({} as never, {} as never,
    { deleteMany: deletion('downloads') } as never,
    { commands: { deleteMany: deletion('commands') }, limits: { deleteMany: deletion('limits') } } as never);
  await store.purgeExpiredQueue(123456);
  assert.deepEqual(calls, [
    { kind: 'limits', filter: { retryAt: { $lte: 123456 } } },
    { kind: 'commands', filter: { retiredAt: { $lte: 123456 - 30 * 86400000 }, state: { $in: ['succeeded', 'closed'] }, projected: true } },
    { kind: 'downloads', filter: { 'executionMode': 'remote', 'remoteRequest.queueExpiresAt': { $lte: 123456 },
      'remoteAssociation': { $exists: false }, 'remoteOutcome': { $nin: ['succeeded', 'duplicate'] } } },
    { kind: 'commands', filter: { 'queueExpiresAt': { $lte: 123456 },
      'state': { $nin: ['succeeded', 'duplicate'] }, 'result.outcome': { $nin: ['succeeded', 'duplicate'] } } },
  ]);
});

test('rearming a failed attempt removes old execution and envelope fields with the same atomic revision check', async () => {
  let filter: unknown;
  let update: { $set: unknown; $unset: unknown } | undefined;
  const store = new MongoRemoteControlStore({} as never, {} as never, {} as never,
    { commands: { updateOne(f: unknown, u: typeof update) {
      filter = f;
      update = u;
      return { exec: async () => ({ modifiedCount: 1 }) };
    } } } as never);
  const previous = { commandId: 'command', revision: 2, executionId: 'old', envelope: 'old-envelope',
    result: { outcome: 'failed' }, queueExpiresAt: 7000 } as CommandRecord;
  const next = { commandId: 'command', revision: 3, queueExpiresAt: 7000 } as CommandRecord;
  assert.equal(await store.compareCommand(previous, next), true);
  assert.deepEqual(filter, { commandId: 'command', revision: 2 });
  assert.deepEqual(update?.$unset, { executionId: 1, envelope: 1, result: 1 });
  assert.deepEqual(update?.$set, next);
});

test('REAL Mongo (opt-in): resource cooldown is durable and uniquely scoped to user/site/torrent', {
  skip: !process.env.REMOTE_GATEWAY_TEST_MONGODB_URI, timeout: 30_000,
}, async (t) => {
  const name = 'popular_resource_limit_test_' + randomUUID().replaceAll('-', '');
  const connection = await createConnection(process.env.REMOTE_GATEWAY_TEST_MONGODB_URI!, {
    dbName: name, serverSelectionTimeoutMS: 5000,
  }).asPromise();
  t.after(async () => {
    assert.equal(connection.name, name);
    await connection.dropDatabase();
    await connection.close();
  });
  const models = createRemoteCommandModels(connection);
  await models.limits.init();
  const store = new MongoRemoteControlStore({} as never, {} as never, {} as never, models);
  const now = 1_800_000_000_000;
  const limit = { ownerId: 'user-a', source: 'mteam', resourceId: '42', kind: 'torrent_daily_limit' as const,
    detectedAt: now, retryAt: now + 86400000 };
  await Promise.all(Array.from({ length: 8 }, () => store.saveResourceDownloadLimit(limit)));
  assert.equal(await models.limits.countDocuments(), 1);
  const restarted = new MongoRemoteControlStore({} as never, {} as never, {} as never, createRemoteCommandModels(connection));
  assert.equal((await restarted.resourceDownloadLimit(limit, now))!.retryAt, limit.retryAt);
  for (const scope of [{ ...limit, ownerId: 'user-b' }, { ...limit, source: 'hdarea' }, { ...limit, resourceId: '43' }])
    assert.equal(await restarted.resourceDownloadLimit(scope, now), null);
  assert.equal(await restarted.resourceDownloadLimit(limit, limit.retryAt), null);
  await store.saveResourceDownloadLimit({ ...limit, detectedAt: now - 1000, retryAt: limit.retryAt - 1000 });
  assert.equal((await store.resourceDownloadLimit(limit, now))!.retryAt, limit.retryAt);
  await store.saveResourceDownloadLimit({ ...limit, detectedAt: limit.retryAt, retryAt: limit.retryAt + 86400000 });
  assert.equal((await store.resourceDownloadLimit(limit, limit.retryAt))!.retryAt, limit.retryAt + 86400000);
});
