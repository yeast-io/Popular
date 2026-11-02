import assert from 'node:assert/strict';
import test from 'node:test';
import type { TransmissionClientPort, TransmissionTorrent } from '../../modules/integrations/transmission.types.js';
import { TransmissionDownloadAdapter } from './transmission-download.adapter.js';

test('Transmission binds credentials and normalizes add, list and label lookup results', async () => {
  const calls: unknown[][] = [];
  const torrent: TransmissionTorrent = { hash: 'hash', name: 'Movie', status: 0, error: 0, progress: 0.25,
    downloadedBytes: 25, totalBytes: 100, downloadSpeed: 2, etaSeconds: 30, labels: ['tag'] };
  const client = {
    async addTorrent(...args: unknown[]) {
      calls.push(args);
      return 'hash';
    },
    async listTorrents(...args: unknown[]) {
      calls.push(args);
      return [torrent];
    },
    async findByTag(...args: unknown[]) {
      calls.push(args);
      return torrent;
    },
  } as unknown as TransmissionClientPort;
  const credential = { username: 'alice', password: 'test-secret' };
  const adapter = new TransmissionDownloadAdapter(client, 'https://transmission.example.com', credential);
  assert.equal(await adapter.add('https://site.example/torrent', 'tag'), 'hash');
  const listed = await adapter.list(['hash']);
  assert.equal(listed[0]?.status, 'paused');
  assert.equal(listed[0]?.progress, 25);
  assert.deepEqual(await adapter.findByTag('tag'), listed[0]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call[0], 'https://transmission.example.com');
    assert.equal(call[1], credential);
  }
});
