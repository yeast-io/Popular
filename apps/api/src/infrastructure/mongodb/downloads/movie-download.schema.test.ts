import assert from 'node:assert/strict';
import test from 'node:test';
import { Mongoose } from 'mongoose';
import { createMovieDownloadModel } from './movie-download.schema.js';

test('expires only missing download records, using the stored absolute deadline', () => {
  const model = createMovieDownloadModel(new Mongoose().createConnection());
  const index = model.schema.indexes().find(([keys]) => keys.expiresAt === 1);
  assert.ok(index);
  assert.equal(index[1].expireAfterSeconds, 0);
  assert.deepEqual(index[1].partialFilterExpression, { status: 'missing' });
  assert.equal(model.schema.path('missingSince').instance, 'Date');
  assert.equal(model.schema.path('expiresAt').instance, 'Date');
});

test('remote queue records may have an unknown downloader type while local downloads still require it', () => {
  const model = createMovieDownloadModel(new Mongoose().createConnection());
  const input = { ownerId: '507f1f77bcf86cd799439011', tmdbId: 603, sourceProvider: 'mteam',
    sourceReleaseId: '991', lookupTag: 'queue-identity', status: 'submitting', progress: 0 };
  assert.ok(new model(input).validateSync()?.errors.provider);
  assert.equal(new model({ ...input, executionMode: 'remote' }).validateSync(), undefined);
});
