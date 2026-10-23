import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteCommandSchema } from './remote-command.schema.js';
import { MongoRemoteCommandIndexMigration } from './remote-command-index-migration.store.js';

test('command IDs remain unique while multiple command attempts can share a download ID', () => {
  const indexes = remoteCommandSchema.indexes();
  assert.ok(indexes.some(([key, options]) => key.commandId === 1 && options.unique));
  assert.equal(indexes.some(([key, options]) => key.downloadId === 1 && options.unique), false);
  assert.ok(indexes.some(([key]) => key.downloadId === 1 && key.createdAt === 1));
});

test('migration removes only the legacy unique download constraint, preserves other indexes and is restartable', async () => {
  let indexes = [
    { name: '_id_', key: { _id: 1 }, unique: true },
    { name: 'commandId_1', key: { commandId: 1 }, unique: true },
    { name: 'downloadId_1', key: { downloadId: 1 }, unique: true },
    { name: 'downloadId_1_createdAt_1', key: { downloadId: 1, createdAt: 1 } },
    { name: 'other', key: { downloadId: 1, ownerId: 1 }, unique: true },
  ];
  const dropped: string[] = [];
  let ready = false;
  const migration = new MongoRemoteCommandIndexMigration({
    async init() { ready = true; },
    collection: {
      async indexes() {
        assert.equal(ready, true);
        return indexes;
      },
      async dropIndex(name: string) {
        dropped.push(name);
        indexes = indexes.filter((index) => index.name !== name);
      },
    },
  } as never);
  await migration.migrate();
  await migration.migrate();
  assert.deepEqual(dropped, ['downloadId_1']);
  assert.equal(indexes.length, 4);
});

test('migration fails before relaxing constraints when command uniqueness is absent', async () => {
  const migration = new MongoRemoteCommandIndexMigration({
    async init() {},
    collection: {
      async indexes() { return [{ name: 'downloadId_1', key: { downloadId: 1 }, unique: true }]; },
      async dropIndex() { assert.fail('must preserve legacy constraint if command uniqueness is absent'); },
    },
  } as never);
  await assert.rejects(migration.migrate(), /unique commandId index/);
});
