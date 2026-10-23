import { fingerprint } from '../../../modules/remote-downloads/remote-download.domain.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MISSING_DOWNLOAD_RETENTION_MS } from '../../../modules/downloads/movie-download.policy.js';
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
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown>; $unset: Record<string, unknown> }
    ) {
      assert.deepEqual(filter, { _id: 'download-one', status: { $in: ['failed', 'missing'] } });
      assert.equal(update.$set.status, 'submitting');
      assert.equal('provider' in update.$set, false);
      for (const field of [
        'missingSince',
        'expiresAt',
        'downloadedBytes',
        'totalBytes',
        'downloadSpeed',
        'etaSeconds',
      ]) {
        assert.equal(update.$unset[field], 1);
      }
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

test('missing updates initialize a fixed seven-day deadline atomically instead of extending it on polls', async () => {
  const writes: unknown[] = [];
  const store = new MongoMovieDownloadStore({
    findByIdAndUpdate(id: string, update: unknown) {
      assert.equal(id, 'download-one');
      writes.push(update);
      return query({ ...row, status: 'missing', progress: 2 });
    },
  } as never);
  const first = new Date('2026-10-20T00:00:00Z');
  const later = new Date('2026-10-21T00:00:00Z');
  for (const time of [first, later]) {
    const result = await store.markMissing('download-one', time);
    assert.equal(result.progress, 2);
    assert.deepEqual(writes.at(-1), [
      {
        $set: {
          status: 'missing',
          lastErrorCode: 'DOWNLOAD_TORRENT_MISSING',
          lastSyncedAt: time,
          missingSince: { $ifNull: ['$missingSince', time] },
          expiresAt: { $add: [{ $ifNull: ['$missingSince', time] }, 604800000] },
          downloadSpeed: 0,
          etaSeconds: '$$REMOVE',
        },
      },
    ]
    );
  }
  assert.equal(MISSING_DOWNLOAD_RETENTION_MS, 604800000);
});

test('restored downloader progress and failed retries cancel the missing-record expiry', async () => {
  const writes: Array<{ $unset: Record<string, number> }> = [];
  const store = new MongoMovieDownloadStore({
    findByIdAndUpdate(_id: string, update: { $unset: Record<string, number> }) {
      writes.push(update);
      return query(row);
    },
  } as never);
  await store.updateProgress('download-one', {
    torrentHash: 'hash',
    name: 'Movie',
    status: 'downloading',
    progress: 2,
    downloadedBytes: 2,
    totalBytes: 100,
    downloadSpeed: 1,
    etaSeconds: 98,
    lastSyncedAt: new Date(),
  }
  );
  await store.markFailed('download-one', 'REMOTE_ERROR', new Date());
  for (const write of writes) {
    assert.equal(write.$unset.missingSince, 1);
    assert.equal(write.$unset.expiresAt, 1);
  }
});

test('HDArea persistence uses source in both lookup and unique creation and preserves it in mapping', async () => {
  const store = new MongoMovieDownloadStore({
    findOne(filter: Record<string, unknown>) {
      assert.equal(filter.sourceProvider, 'hdarea');
      return query({ ...row, sourceProvider: 'hdarea' });
    },
    async create(input: Record<string, unknown>) {
      assert.equal(input.sourceProvider, 'hdarea');
      return { toObject: () => input };
    },
  } as never);
  assert.equal((await store.findByRelease('owner-one', 603, '991', 'hdarea'))?.sourceProvider, 'hdarea');
  assert.equal(
    (await store.createSubmitting('owner-one', 603, '991', 'transmission', 'hdarea')).record.sourceProvider,
    'hdarea'
  );
});

test('a remote claim atomically persists its recoverable command identity, pinned downloader and original queue deadline', async () => {
  let stored!: Record<string, unknown>;
  const store = new MongoMovieDownloadStore({ async create(input: Record<string, unknown>) {
    stored = input;
    return { toObject: () => input };
  } } as never);
  const result = await store.createSubmitting('owner-one', 603, '991', 'transmission', 'mteam', undefined,
    'Popular Link Agent', { deviceId: 'device-a', authVersion: 2, deviceVersion: 3, correlationId: 'trace-original',
      targetDownloader: { downloaderType: 'transmission', instanceId: 'nas-1' } });
  const intent = stored.remoteRequest as Record<string, unknown>;
  assert.equal(stored.executionMode, 'remote');
  assert.equal(result.record.remoteCorrelationId, 'trace-original');
  assert.equal(result.record.remoteCommandId, intent.commandId);
  assert.equal(Number(intent.queueExpiresAt) - Number(intent.createdAt), 7 * 86400000);
  assert.equal(intent.digest, fingerprint({ commandId: intent.commandId, downloadId: result.record.id,
    ownerId: 'owner-one', deviceId: 'device-a', authVersion: 2, deviceVersion: 3,
    source: 'mteam', resourceId: '991', correlationId: 'trace-original' }));
  assert.deepEqual(intent.targetDownloader, { downloaderType: 'transmission', instanceId: 'nas-1' });
  assert.equal(JSON.stringify(stored).includes('torrentUrl'), false);
});
