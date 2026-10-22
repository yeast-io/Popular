import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { createModels } from './models.js';

test('tenant-owned state has unique owner and movie index', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  const indexes = models.userMovieStates.schema.indexes();
  assert.ok(
    indexes.some(([fields, options]) => {
      return fields.ownerId === 1 && fields.tmdbId === 1 && options.unique === true;
    })
  );
  void connection.destroy();
});

test('scheduler lookup and lease fields share a compound index', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  const indexes = models.syncJobs.schema.indexes();
  assert.ok(
    indexes.some(([fields]) => {
      return fields.enabled === 1 && fields.nextRunAt === 1 && fields.leaseExpiresAt === 1;
    })
  );
  void connection.destroy();
});

test('movie localizations, people, and credits have stable identity indexes', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  assert.ok(
    models.movies.schema.indexes().some(([fields, options]) => {
      return fields.tmdbId === 1 && options.unique === true;
    })
  );
  assert.ok(
    models.movieLocalizations.schema.indexes().some(([fields, options]) => {
      return fields.movieTmdbId === 1 && fields.locale === 1 && options.unique === true;
    })
  );
  assert.ok(
    models.people.schema.indexes().some(([fields, options]) => {
      return fields.tmdbId === 1 && fields.locale === 1 && options.unique === true;
    })
  );
  assert.ok(
    models.movieCredits.schema.indexes().some(([fields, options]) => {
      return (
        fields.movieTmdbId === 1
        && fields.locale === 1
        && fields.syncVersion === 1
        && fields.tmdbCreditId === 1
        && options.unique === true
      );
    })
  );
  void connection.destroy();
});

test('integration configurations are unique per owner and provider and hide secrets by default', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  assert.ok(
    models.integrationConfigs.schema.indexes().some(([fields, options]) => {
      return fields.ownerId === 1 && fields.provider === 1 && options.unique === true;
    })
  );
  assert.equal(models.integrationConfigs.schema.path('encryptedApiKey').options.select, false);
  assert.ok(
    models.qbittorrentConfigs.schema.indexes().some(([fields, options]) => {
      return fields.ownerId === 1 && options.unique === true;
    })
  );
  assert.equal(models.qbittorrentConfigs.schema.path('encryptedCredential').options.select, false);
  assert.ok(
    models.transmissionConfigs.schema.indexes().some(([fields, options]) => {
      return fields.ownerId === 1 && options.unique === true;
    })
  );
  assert.equal(models.transmissionConfigs.schema.path('encryptedCredential').options.select, false);
  void connection.destroy();
});

test('movie downloads are unique per owner, movie, source, and release', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  assert.ok(
    models.movieDownloads.schema.indexes().some(([fields, options]) => {
      return (
        fields.ownerId === 1
        && fields.tmdbId === 1
        && fields.sourceProvider === 1
        && fields.sourceReleaseId === 1
        && options.unique === true
      );
    })
  );
  void connection.destroy();
});

test('movie resource checks use the complete task identity as their unique key', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  assert.ok(
    models.movieResourceChecks.schema.indexes().some(([fields, options]) => {
      return fields.ownerId === 1 && fields.tmdbId === 1 && fields.provider === 1 && options.unique === true;
    })
  );
  assert.deepEqual(Object.keys(models.movieResourceChecks.schema.paths).sort(), [
    '_id',
    'availability',
    'checkedAt',
    'createdAt',
    'expiresAt',
    'identityFingerprint',
    'lastAttemptAt',
    'lastAttemptStatus',
    'lastErrorCode',
    'matchedBy',
    'ownerId',
    'provider',
    'tmdbId',
    'updatedAt',
  ]
  );
  assert.ok(
    models.movieResourceCheckTasks.schema.indexes().some(([fields, options]) => {
      return fields.ownerId === 1 && fields.tmdbId === 1 && fields.provider === 1 && options.unique === true;
    })
  );
  void connection.destroy();
});

test('movie resource sync permits only one active batch per owner', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  assert.ok(
    models.movieResourceSyncBatches.schema.indexes().some(([fields, options]) => {
      return (
        fields.ownerId === 1
        && fields.active === 1
        && options.unique === true
        && options.partialFilterExpression?.active === true
      );
    })
  );
  void connection.destroy();
});

test('external usage keeps idempotent request events and expires both collections', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);

  assert.ok(
    models.externalRequestEvents.schema.indexes().some(([fields, options]) => {
      return (
        fields.operationId === 1
        && fields.provider === 1
        && fields.operation === 1
        && fields.attempt === 1
        && options.unique === true
      );
    })
  );
  assert.ok(
    models.externalRequestEvents.schema.indexes().some(([fields, options]) => {
      return fields.expiresAt === 1 && options.expireAfterSeconds === 0;
    })
  );
  assert.ok(
    models.externalUsageDaily.schema.indexes().some(([fields, options]) => {
      return (
        fields.bucketDate === 1
        && fields.scopeKey === 1
        && fields.provider === 1
        && fields.operation === 1
        && options.unique === true
      );
    })
  );
  assert.ok(
    models.externalUsageDaily.schema.indexes().some(([fields, options]) => {
      return fields.expiresAt === 1 && options.expireAfterSeconds === 0;
    })
  );
  void connection.destroy();
});

test('conversation schemas index owner listings, message order, and idempotency', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  assert.ok(
    models.conversationMessages.schema.indexes().some(([fields, options]) => {
      return fields.threadId === 1 && fields.sequence === 1 && options.unique === true;
    })
  );
  assert.ok(
    models.conversationMessages.schema.indexes().some(([fields, options]) => {
      return (
        fields.ownerId === 1
        && fields.threadId === 1
        && fields.role === 1
        && fields.clientRequestId === 1
        && options.unique === true
      );
    })
  );
  assert.ok(
    models.conversationThreads.schema.indexes().some(([fields]) => {
      return fields.ownerId === 1 && fields.updatedAt === -1;
    })
  );
  assert.ok(models.conversationThreads.schema.path('summary'));

  void connection.destroy();
});

test('external usage accepts new provider ids without a schema change', () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  const common = {
    provider: 'future_tracker',
    operation: 'release.search',
    expiresAt: new Date('2027-01-11T00:00:00.000Z'),
  };

  const event = new models.externalRequestEvents({
    ...common,
    actorType: 'system',
    trigger: 'scheduled_sync',
    outcome: 'success',
    durationMs: 10,
    operationId: 'operation-1',
    attempt: 1,
    occurredAt: new Date('2026-10-13T00:00:00.000Z'),
  });
  const daily = new models.externalUsageDaily({
    ...common,
    bucketDate: new Date('2026-10-13T00:00:00.000Z'),
    scopeKey: 'global',
    successCount: 1,
    failureCount: 0,
    totalDurationMs: 10,
    maxDurationMs: 10,
    updatedAt: new Date('2026-10-13T00:05:00.000Z'),
  });
  const invalid = new models.externalRequestEvents({
    ...event.toObject(),
    _id: undefined,
    provider: 'invalid provider!',
  });

  assert.equal(event.validateSync(), undefined);
  assert.equal(daily.validateSync(), undefined);
  assert.match(invalid.validateSync()?.message ?? '', /provider/);
  void connection.destroy();
});

test('OpenAI keys have a unique account index and hide ciphertext by default', () => {
  const connection = mongoose.createConnection();
  const { openaiConfigs } = createModels(connection);
  assert.ok(
    openaiConfigs.schema.indexes().some(([fields, options]) => fields.ownerId === 1 && options.unique === true)
  );
  assert.equal(openaiConfigs.schema.path('encryptedApiKey').options.select, false);
  void connection.destroy();
});
