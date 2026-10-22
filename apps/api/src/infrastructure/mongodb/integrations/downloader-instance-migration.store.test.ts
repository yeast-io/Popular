import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from 'mongoose';
import type { QBittorrentConfigDocument } from './qbittorrent-config.schema.js';
import type { TransmissionConfigDocument } from './transmission-config.schema.js';
import type { MovieDownloadDocument } from '../downloads/movie-download.schema.js';
import type { IntegrationPreferencesDocument } from './integration-preferences.schema.js';
import { MongoDownloaderInstanceMigration } from './downloader-instance-migration.store.js';

test('legacy direct downloads and defaults inherit a stable instance ID across restart', async () => {
  const row = { _id: 'config-1', ownerId: 'owner-1', downloaderInstanceId: undefined as string | undefined, name: undefined as string | undefined };
  const backfills: unknown[] = [];
  const defaults: unknown[] = [];
  let dropped = 0;
  const cursorFor = (rows: Array<typeof row>) => ({
    select: () => ({
      lean: () => ({
        async* cursor() {
          for (const item of rows) yield { ...item };
        },
      }),
    }),
  });
  const config = {
    find() {
      return cursorFor([row]);
    },
    findById() {
      return { select: () => ({ lean: () => ({ exec: async () => ({ ...row }) }) }) };
    },
    updateOne(filter: { downloaderInstanceId?: { $exists: boolean } }, update: { $set: { downloaderInstanceId?: string; name?: string } }) {
      return { exec: async () => {
        if (filter.downloaderInstanceId && row.downloaderInstanceId) return;
        row.downloaderInstanceId = update.$set.downloaderInstanceId ?? row.downloaderInstanceId;
        row.name = update.$set.name ?? row.name;
      } };
    },
    collection: {
      indexes: async () => dropped ? [] : [{ name: 'ownerId_1', unique: true }],
      dropIndex: async () => {
        dropped++;
      },
    },
    init: async () => {},
  };
  const emptyConfig = {
    find() {
      return cursorFor([]);
    },
    collection: { indexes: async () => {
      throw Object.assign(new Error('namespace not found'), { code: 26 });
    }, dropIndex: async () => {} },
    init: async () => {},
  };
  const downloads = { updateMany: (filter: unknown, update: unknown) => ({ exec: async () => {
    backfills.push({ filter, update });
  } }) };
  const preferences = { updateOne: (filter: unknown, update: unknown) => ({ exec: async () => {
    defaults.push({ filter, update });
  } }) };
  const migration = new MongoDownloaderInstanceMigration(
    config as unknown as Model<QBittorrentConfigDocument>,
    emptyConfig as unknown as Model<TransmissionConfigDocument>,
    downloads as unknown as Model<MovieDownloadDocument>,
    preferences as unknown as Model<IntegrationPreferencesDocument>
  );
  await migration.migrate();
  const id = row.downloaderInstanceId;
  assert.match(id!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(row.name, 'qBittorrent');
  await migration.migrate();
  assert.equal(row.downloaderInstanceId, id);
  assert.equal(dropped, 1);
  assert.deepEqual(backfills[0], {
    filter: { ownerId: 'owner-1', provider: 'qbittorrent', executionMode: { $ne: 'remote' }, downloaderInstanceId: { $exists: false } },
    update: { $set: { downloaderInstanceId: id, downloaderName: 'qBittorrent' } },
  });
  assert.deepEqual(defaults[0], {
    filter: { 'ownerId': 'owner-1', 'defaults.downloader': 'qbittorrent' },
    update: { $set: { 'defaults.downloader': id } },
  });
});
