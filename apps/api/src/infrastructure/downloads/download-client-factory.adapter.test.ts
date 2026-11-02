import assert from 'node:assert/strict';
import test from 'node:test';
import type { QBittorrentConfigRecord, QBittorrentClientPort, QBittorrentConfigStore } from '../../modules/integrations/qbittorrent.types.js';
import { SecretCrypto } from '../../modules/integrations/secret-crypto.js';
import { ConfiguredDownloadClientFactory } from './download-client-factory.adapter.js';

function fixture() {
  const calls: unknown[][] = [];
  const secrets = new SecretCrypto('download-client-factory-test-secret-at-least-32');
  const records: QBittorrentConfigRecord[] = ['home', 'seedbox'].map((id) => ({
    ownerId: 'alice', downloaderInstanceId: id, name: id, authMethod: 'api_key',
    baseUrl: `https://${id}.example.com`,
    encryptedCredential: secrets.encrypt(JSON.stringify({ authMethod: 'api_key', apiKey: `${id}-key` }),
      'movie-hub:integration:qbittorrent:owner:alice'),
  }));
  const configs = {
    async list(ownerId) { return records.filter((record) => record.ownerId === ownerId); },
    async find(ownerId, id) {
      return records.find((record) => record.ownerId === ownerId && record.downloaderInstanceId === id) ?? null;
    },
  } as QBittorrentConfigStore;
  const client = {
    async addTorrent(...args: unknown[]) { calls.push(args); },
    async listTorrents(...args: unknown[]) {
      calls.push(args);
      return [{ hash: 'hash', name: 'Movie', state: 'stalledUP', progress: 1.2,
        downloadedBytes: 100, totalBytes: 100, downloadSpeed: 0, etaSeconds: 0, tags: ['tag'] }];
    },
  } as unknown as QBittorrentClientPort;
  const factory = new ConfiguredDownloadClientFactory({ qbittorrent: { configs, client }, secrets });
  return { factory, calls, records };
}

test('multiple instances require a pinned ID; the bound adapter keeps its address and credentials', async () => {
  const f = fixture();
  assert.deepEqual((await f.factory.instancesFor('alice')).map((item) => item.downloaderInstanceId), ['home', 'seedbox']);
  await assert.rejects(f.factory.clientFor('alice', 'qbittorrent'), { code: 'DOWNLOAD_PROVIDER_REQUIRED' });
  const bound = await f.factory.clientFor('alice', 'qbittorrent', 'seedbox');
  assert.equal(await bound.add('https://site.example/torrent', 'tag'), undefined);
  const snapshots = await bound.list(['hash']);
  assert.equal(snapshots[0]?.status, 'seeding');
  assert.equal(snapshots[0]?.progress, 100);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call[0], 'https://seedbox.example.com');
    assert.deepEqual(call[1], { authMethod: 'api_key', apiKey: 'seedbox-key' });
  }
});

test('instance IDs never grant access to another owner or select a fallback downloader', async () => {
  const f = fixture();
  assert.deepEqual(await f.factory.instancesFor('bob'), []);
  await assert.rejects(f.factory.clientFor('bob', 'qbittorrent', 'seedbox'), { code: 'QBITTORRENT_NOT_CONFIGURED' });
  await assert.rejects(f.factory.clientFor('alice', 'qbittorrent', 'deleted'), { code: 'QBITTORRENT_NOT_CONFIGURED' });
  await assert.rejects(f.factory.clientFor('alice', 'transmission'), { code: 'TRANSMISSION_NOT_CONFIGURED' });
  assert.equal(f.calls.length, 0);
});

test('invalid addresses and credentials fail before any protocol call', async () => {
  const f = fixture();
  f.records[0]!.baseUrl = 'http://127.0.0.1:8080';
  await assert.rejects(f.factory.clientFor('alice', 'qbittorrent', 'home'), { code: 'QBITTORRENT_INVALID_URL' });
  f.records[1]!.encryptedCredential = 'invalid-ciphertext';
  await assert.rejects(f.factory.clientFor('alice', 'qbittorrent', 'seedbox'), { code: 'INTERNAL_ERROR' });
  assert.equal(f.calls.length, 0);
});
