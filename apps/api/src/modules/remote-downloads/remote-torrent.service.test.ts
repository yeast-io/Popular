import assert from 'node:assert/strict';
import test from 'node:test';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { RemoteTorrentService } from './remote-torrent.service.js';

test('remote delivery resolves the authenticated command source before reading torrent metadata', async () => {
  const calls: string[] = [];
  const service = new RemoteTorrentService({
    async resolveRemote(input) {
      assert.deepEqual(input, { ownerId: 'alice', tmdbId: 603, source: 'hdarea', releaseId: '42' });
      calls.push('source');
      return 'https://site.example/torrent?passkey=secret';
    },
  }, async (url, options) => {
    assert.equal(url, 'https://site.example/torrent?passkey=secret');
    assert.equal(options?.source, 'hdarea');
    calls.push('metadata');
    return 'torrent-hash';
  });
  const result = await service.resolve({ ownerId: 'alice', source: 'hdarea', resourceId: '42' }, { tmdbId: 603 });
  assert.deepEqual(result, { url: 'https://site.example/torrent?passkey=secret', torrentHash: 'torrent-hash' });
  assert.deepEqual(calls, ['source', 'metadata']);
});

test('source failures skip metadata retrieval and preserve the original RPC error', async () => {
  const error = new RpcError('RESOURCE_SITE_NOT_CONFIGURED', 'not_applied');
  const service = new RemoteTorrentService({ resolveRemote: async () => {
    throw error;
  } }, async () => {
    assert.fail('metadata must not be fetched after a source failure');
  });
  await assert.rejects(service.resolve({ ownerId: 'alice', source: 'mteam', resourceId: '42' }, {}),
    (actual) => actual === error);
});

test('metadata failures retain their original cause and never return a partial torrent result', async () => {
  const cause = new Error('metadata parser failed');
  const error = new RpcError('TORRENT_METADATA_UNAVAILABLE', 'not_applied', { cause });
  const service = new RemoteTorrentService({ resolveRemote: async () => 'https://site.example/torrent' },
    async () => { throw error; });
  await assert.rejects(service.resolve({ ownerId: 'alice', source: 'mteam', resourceId: '42' }, {}),
    (actual) => actual instanceof RpcError && actual === error && actual.cause === cause);
});
