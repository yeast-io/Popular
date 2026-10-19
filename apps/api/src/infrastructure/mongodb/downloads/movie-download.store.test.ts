import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoMovieDownloadStore } from './movie-download.store.js';

const row = {
  _id: 'download-one',
  ownerId: 'owner-one',
  tmdbId: 603,
  sourceProvider: 'mteam',
  sourceReleaseId: '991',
  provider: 'transmission',
  lookupTag: 'movie-hub-one',
  status: 'submitting',
  progress: 0,
};
const query = (value: unknown) => ({ lean: () => ({ exec: async () => value }) });

test('persists the selected provider and returns a lost unique release claim without granting submission', async () => {
  let stored: Record<string, unknown> | undefined;
  let duplicate = false;
  const store = new MongoMovieDownloadStore({
    async create(input: Record<string, unknown>) {
      if (duplicate) throw { code: 11000 };
      stored = input;
      return { toObject: () => input };
    },
    findOne(filter: unknown) {
      assert.deepEqual(filter, { ownerId: 'owner-one', tmdbId: 603, sourceProvider: 'mteam', sourceReleaseId: '991' });
      return query(stored);
    },
  } as never);
  const first = await store.createSubmitting('owner-one', 603, '991', 'transmission');
  assert.equal(first.claimed, true);
  assert.equal(first.record.provider, 'transmission');
  duplicate = true;
  const other = await store.createSubmitting('owner-one', 603, '991', 'qbittorrent');
  assert.equal(other.claimed, false);
  assert.equal(other.record.provider, 'transmission');
  assert.equal(other.record.id, first.record.id);
});

test('retry claims require a failed or missing record; a losing retry returns the current task', async () => {
  let winner = true;
  const store = new MongoMovieDownloadStore({
    findOneAndUpdate(filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) {
      assert.deepEqual(filter, { _id: 'download-one', status: { $in: ['failed', 'missing'] } });
      assert.equal(update.$set.status, 'submitting');
      assert.equal('provider' in update.$set, false);
      return query(winner ? row : null);
    },
    findById(id: string) {
      assert.equal(id, 'download-one');
      return query(row);
    },
  } as never);
  assert.equal((await store.retry('download-one')).claimed, true);
  winner = false;
  const lost = await store.retry('download-one');
  assert.equal(lost.claimed, false);
  assert.equal(lost.record.provider, 'transmission');
});
