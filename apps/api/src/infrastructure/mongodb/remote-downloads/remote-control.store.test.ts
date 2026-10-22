import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { createUserModel } from '../users/user.schema.js';
import { createRemoteDeviceModel } from '../remote-clients/remote-device.schema.js';
import { createMovieDownloadModel } from '../downloads/movie-download.schema.js';
import { createRemoteCommandModels } from './remote-command.schema.js';
import { MongoRemoteControlStore } from './remote-control.store.js';
import type { CommandRecord, DeviceKeys } from '@movie-hub/contract';
import { fingerprint } from '../../../modules/remote-downloads/remote-download.domain.js';

test(
  'REAL standalone Mongo (opt-in): concurrent binding, durable CAS, original projection and out-of-order status',
  {
    skip: !process.env.REMOTE_GATEWAY_TEST_MONGODB_URI,
    timeout: 30_000,
  },
  async (t) => {
    const connection = await createConnection(process.env.REMOTE_GATEWAY_TEST_MONGODB_URI!, {
      dbName: 'popular_gateway_test_' + randomUUID().replaceAll('-', ''),
      serverSelectionTimeoutMS: 5000,
    }
    ).asPromise();
    t.after(async () => {
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
