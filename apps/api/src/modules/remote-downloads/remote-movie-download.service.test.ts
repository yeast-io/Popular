import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection, type Model } from 'mongoose';
import type { DownloadRequest } from '@movie-hub/contract';
import { createMovieDownloadModel } from '../../infrastructure/mongodb/downloads/movie-download.schema.js';
import type { MovieDownloadDocument } from '../../infrastructure/mongodb/downloads/movie-download.schema.js';
import { MongoMovieDownloadStore } from '../../infrastructure/mongodb/downloads/movie-download.store.js';
import type { RemoteClientService } from '../remote-clients/remote-client.service.js';
import type { RemoteDownloadCoordinator } from './remote-download-coordinator.service.js';
import { RemoteMovieDownloadService } from './remote-movie-download.service.js';
import { fingerprint } from './remote-download.domain.js';

function fixture(knownDownloader = true) {
  const model = createMovieDownloadModel(createConnection());
  let row: (MovieDownloadDocument & { _id: unknown }) | undefined;
  let creations = 0;
  const matches = (filter: Record<string, unknown>) => row && Object.entries(filter).every(([key, expected]) => {
    const actual = key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], row);
    return String(actual) === String(expected);
  });
  const store = new MongoMovieDownloadStore({
    async create(input: unknown) {
      creations++;
      const document = new model(input);
      assert.equal(document.validateSync(), undefined);
      row = document.toObject() as MovieDownloadDocument & { _id: unknown };
      return document;
    },
    findOne(filter: Record<string, unknown>) {
      return { lean: () => ({ exec: async () => matches(filter) ? { ...row } : null }) };
    },
    findOneAndUpdate(filter: Record<string, unknown>, update: { $set: Record<string, unknown>; $unset: Record<string, number> }) {
      return { lean: () => ({ exec: async () => {
        if (!matches(filter)) return null;
        const next = { ...row, ...update.$set } as Record<string, unknown>;
        for (const key of Object.keys(update.$unset)) delete next[key];
        const document = new model(next);
        assert.equal(document.validateSync(), undefined);
        row = document.toObject() as MovieDownloadDocument & { _id: unknown };
        return { ...row };
      } }) };
    },
  } as unknown as Model<MovieDownloadDocument>);
  const ownerId = '507f1f77bcf86cd799439011';
  const clients = { async get(owner: string) {
    return { hasKey: owner === ownerId, devices: owner === ownerId
      ? [{ id: 'device-a', authVersion: 1,
          deviceVersion: 1, ...(knownDownloader ? { downloaderType: 'transmission', downloaderInstanceId: 'original-nas' } : {}),
          isAgentOnline: false, isAgentDownloaderOnline: false }]
      : [] };
  } } as unknown as RemoteClientService;
  const calls: DownloadRequest[] = [];
  const coordinator = { async enqueue(input: DownloadRequest) {
    calls.push(input);
  } } as unknown as RemoteDownloadCoordinator;
  const service = new RemoteMovieDownloadService(store, clients, coordinator);
  return { service, ownerId, calls, row: () => row!, creations: () => creations };
}

test('remote submission atomically saves a recoverable intent before dispatch and repeats with its original correlation/deadline', async () => {
  const f = fixture();
  const first = await f.service.create(f.ownerId, 603, '991', 'mteam', 'device-a', 'en-US');
  assert.equal(first.executionMode, 'remote');
  assert.equal(first.remoteDeviceId, 'device-a');
  assert.equal(first.status, 'submitting');
  assert.ok(first.queueExpiresAt);
  assert.equal(f.row().remoteRequest?.digest, fingerprint(f.calls[0]));
  const intent = f.row().remoteRequest!;
  assert.equal(intent.queueExpiresAt! - intent.createdAt!, 7 * 86400000);
  assert.equal(f.row().remoteRequest?.targetDownloader?.instanceId, 'original-nas');
  const second = await f.service.create(f.ownerId, 603, '991', 'mteam', 'device-a', 'zh-CN');
  assert.equal(second.id, first.id);
  assert.equal(second.queueExpiresAt, first.queueExpiresAt);
  assert.deepEqual(f.calls[1], f.calls[0]);
  assert.equal(f.creations(), 1);
  assert.equal(JSON.stringify(f.row()).includes('torrentUrl'), false);
});

test('remote submission rejects another owner or an invalid device before creating queue records', async () => {
  const f = fixture();
  await assert.rejects(f.service.create('507f1f77bcf86cd799439012', 603, '991', 'mteam', 'device-a', 'en-US'),
    { code: 'DOWNLOAD_PROVIDER_CONFLICT', message: 'The selected device has no valid binding.' });
  await assert.rejects(f.service.create(f.ownerId, 603, '991', 'mteam', 'other-device', 'zh-CN'),
    { code: 'DOWNLOAD_PROVIDER_CONFLICT', message: '所选设备没有有效绑定。' });
  assert.equal(f.creations(), 0);
  assert.equal(f.calls.length, 0);
});

test('a newly bound Agent can queue before its first downloader report without inventing a provider', async () => {
  const f = fixture(false);
  const response = await f.service.create(f.ownerId, 603, '991', 'mteam', 'device-a', 'en-US');
  assert.equal(response.executionMode, 'remote');
  assert.equal(response.provider, undefined);
  assert.equal(f.row().provider, undefined);
  assert.equal(f.row().remoteRequest?.targetDownloader, undefined);
  assert.equal(f.calls.length, 1);
});

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`explicit redownload of a deleted Agent task creates one durable new command under concurrent clicks (${locale})`, async () => {
    const f = fixture();
    const first = await f.service.create(f.ownerId, 603, '991', 'hdarea', 'device-a', locale);
    const oldCommand = f.calls[0]!.commandId;
    Object.assign(f.row(), { status: 'missing', remoteRequestState: 'succeeded', remoteStatusState: 'deleted',
      remoteCommandRegistered: true, remoteOutcome: 'succeeded', remoteProjectionRevision: 20, remoteStatusSequence: 100,
      remoteAssociation: { commandId: oldCommand, executionId: 'old-execution', deviceId: 'device-a',
        authVersion: 1, deviceVersion: 1, downloaderType: 'transmission', instanceId: 'original-nas',
        torrentHash: 'a'.repeat(40), taskId: 'old-task', marker: 'popular-old-execution' },
      progress: 50, downloadedBytes: 50, totalBytes: 100, downloadSpeed: 10, etaSeconds: 5,
      torrentHash: 'a'.repeat(40), name: 'old-task', lastErrorCode: 'DOWNLOAD_TORRENT_MISSING',
      addedAt: new Date(), lastSyncedAt: new Date(), missingSince: new Date(), expiresAt: new Date(),
    });
    // Even when the original queue deadline elapsed, explicit redownload starts a new queue.
    f.row().remoteRequest!.queueExpiresAt = 1;
    f.row().remoteQueueExpiresAt = new Date(1);
    // The successful association is authoritative even if the saved intent target differs.
    f.row().remoteRequest!.targetDownloader = { downloaderType: 'qbittorrent', instanceId: 'replacement' };
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      f.service.create(f.ownerId, 603, '991', 'hdarea', 'device-a', locale)));
    assert.equal(f.creations(), 1);
    assert.ok(results.every((result) => result.id === first.id && result.status === 'submitting' && result.progress === 0));
    const commands = new Set(f.calls.slice(1).map((call) => call.commandId));
    assert.equal(commands.size, 1);
    assert.equal(commands.has(oldCommand), false);
    const intent = f.row().remoteRequest!;
    assert.equal(intent.commandId, f.calls[1]!.commandId);
    assert.equal(intent.digest, fingerprint(f.calls[1]));
    assert.equal(intent.queueExpiresAt! - intent.createdAt!, 7 * 86400000);
    assert.deepEqual(intent.targetDownloader, { downloaderType: 'transmission', instanceId: 'original-nas' });
    assert.equal(f.row().remoteCommandRegistered, false);
    assert.equal(f.row().remoteRequestState, 'accepted');
    for (const field of ['remoteAssociation', 'remoteOutcome', 'remoteProjectionRevision', 'remoteStatusSequence',
      'remoteStatusState', 'expiresAt', 'missingSince', 'lastErrorCode', 'torrentHash', 'name', 'downloadedBytes',
      'totalBytes', 'downloadSpeed', 'etaSeconds', 'addedAt', 'lastSyncedAt']) {
      assert.equal(Object.hasOwn(f.row(), field), false, field);
    }
    const again = await f.service.create(f.ownerId, 603, '991', 'hdarea', 'device-a', locale);
    assert.equal(again.id, first.id);
    assert.equal(f.calls.at(-1)!.commandId, intent.commandId);
  });
}

test('unknown, active and unverified missing Agent tasks never get a fresh command', async () => {
  for (const state of ['unknown', 'downloading', 'missing'] as const) {
    const f = fixture();
    await f.service.create(f.ownerId, 603, '991', 'mteam', 'device-a', 'en-US');
    const intent = f.row().remoteRequest!;
    Object.assign(f.row(), { status: state === 'unknown' ? 'failed' : state, remoteRequestState: state });
    await f.service.create(f.ownerId, 603, '991', 'mteam', 'device-a', 'en-US');
    assert.equal(f.calls[1]!.commandId, intent.commandId);
    assert.equal(f.row().remoteRequest!.digest, intent.digest);
  }
});
