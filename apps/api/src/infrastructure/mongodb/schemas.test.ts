import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { createModels } from './models.js';

test('tenant-owned state has unique owner and movie index', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  const indexes = models.userMovieStates.schema.indexes();
  assert.ok(indexes.some(([fields, options]) =>
    fields.ownerId === 1 && fields.tmdbId === 1 && options.unique === true,
  ));
  void connection.destroy();
});

test('scheduler lookup and lease fields share a compound index', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  const indexes = models.syncJobs.schema.indexes();
  assert.ok(indexes.some(([fields]) =>
    fields.enabled === 1 && fields.nextRunAt === 1 && fields.leaseExpiresAt === 1,
  ));
  void connection.destroy();
});

test('movie localizations, people, and credits have stable identity indexes', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  assert.ok(models.movies.schema.indexes().some(([fields, options]) =>
    fields.tmdbId === 1 && options.unique === true,
  ));
  assert.ok(models.movieLocalizations.schema.indexes().some(([fields, options]) =>
    fields.movieTmdbId === 1 && fields.locale === 1 && options.unique === true,
  ));
  assert.ok(models.people.schema.indexes().some(([fields, options]) =>
    fields.tmdbId === 1 && fields.locale === 1 && options.unique === true,
  ));
  assert.ok(models.movieCredits.schema.indexes().some(([fields, options]) =>
    fields.movieTmdbId === 1 && fields.locale === 1 && fields.syncVersion === 1 && fields.tmdbCreditId === 1 && options.unique === true,
  ));
  void connection.destroy();
});
