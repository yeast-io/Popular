import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { createMovieDownloadModel } from '../downloads/movie-download.schema.js';
import { MongoNotificationStore } from './notification.store.js';
import type { ClaimedDownload } from '../../../modules/notifications/notification.types.js';

test('notification subdocuments are absent for ordinary downloads and store per-channel completion when present', () => {
  const model = createMovieDownloadModel(mongoose.createConnection());
  const base = {
    ownerId: new mongoose.Types.ObjectId(),
    tmdbId: 7,
    sourceProvider: 'mteam',
    sourceReleaseId: 'r',
    provider: 'qbittorrent',
    lookupTag: 'tag',
    status: 'downloading',
  };
  const ordinary = new model(base).toObject();
  assert.equal(ordinary.notificationTask, undefined);
  assert.equal(ordinary.notificationIntent, undefined);
  const tracked = new model({
    ...base,
    notificationTask: { id: 'task', epoch: 0, nextRunAt: new Date(), channels: [{ channel: 'whatsapp' }] },
  });
  assert.equal(tracked.validateSync(), undefined);
  assert.equal(tracked.notificationTask?.downloaded, false);
  assert.equal(tracked.notificationTask?.notified, false);
  assert.equal(tracked.notificationTask?.channels[0]?.notified, false);
  assert.equal('_id' in tracked.toObject().notificationTask!, false);
});

test('scan writes require owner, task attempt, live lease and uncancelled state; only 100 percent valid progress marks downloaded', async () => {
  const writes: Array<{ filter: Record<string, unknown>; update: { $set: Record<string, unknown> } }> = [];
  const store = new MongoNotificationStore(
    {
      updateOne: (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
        writes.push({ filter, update });
        return { exec: async () => ({ matchedCount: 1 }) };
      },
    } as never,
    {} as never,
  );
  const now = new Date();
  const claim: ClaimedDownload = {
    record: {
      id: 'download-a',
      ownerId: 'alice',
      tmdbId: 7,
      provider: 'qbittorrent',
      sourceProvider: 'mteam',
      sourceReleaseId: 'release',
      lookupTag: 'tag',
      status: 'downloading',
      progress: 0,
    },
    task: {
      id: 'attempt-a',
      epoch: 0,
      downloaded: false,
      notified: false,
      cancelled: false,
      channels: [{ channel: 'whatsapp', notified: false }],
      leaseId: 'lease-a',
      lockedUntil: new Date(now.getTime() + 120000),
      nextRunAt: now,
    },
  };
  const progress = {
    torrentHash: 'hash',
    name: 'resource',
    status: 'seeding' as const,
    progress: 99,
    totalBytes: 100,
    downloadedBytes: 99,
    downloadSpeed: 0,
    etaSeconds: 0,
    lastSyncedAt: now,
  };
  await store.downloaded(claim, progress, now);
  assert.equal(claim.task.downloaded, false);
  await store.downloaded(claim, { ...progress, progress: 100, status: 'failed' }, now);
  assert.equal(claim.task.downloaded, false);
  await store.downloaded(claim, { ...progress, progress: 100 }, now);
  assert.equal(claim.task.downloaded, true);
  await store.channelNotified(claim, 'whatsapp', 'msg');
  await store.finish(claim, now);
  for (const { filter } of writes) {
    assert.equal(filter.ownerId, 'alice');
    assert.equal(filter._id, 'download-a');
    assert.equal(filter['notificationTask.id'], 'attempt-a');
    assert.equal(filter['notificationTask.leaseId'], 'lease-a');
    assert.equal(filter['notificationTask.cancelled'], false);
    assert.equal(filter['notificationTask.notified'], false);
    assert.ok(filter['notificationTask.lockedUntil']);
  }
  assert.equal(writes.at(-1)?.update.$set['notificationTask.notified'], true);
});

test('claims exclude completed and cancelled records and use atomic expiry-based leases', async () => {
  const filters: Record<string, unknown>[] = [];
  const store = new MongoNotificationStore(
    {
      findOneAndUpdate: (filter: Record<string, unknown>) => {
        filters.push(filter);
        return { lean: () => ({ exec: async () => null }) };
      },
    } as never,
    {} as never,
  );
  await store.claimTask(new Date());
  assert.equal(filters[0]?.['notificationTask.notified'], false);
  assert.equal(filters[0]?.['notificationTask.cancelled'], false);
  assert.ok(filters[0]?.$or);
  assert.ok(filters[0]?.['notificationTask.nextRunAt']);
});
