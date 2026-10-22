import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { torrentMetadataHash } from './torrent-metadata.schema.js';

test('hashes exact v1/v2 info bytes rather than the download URL or re-encoded metadata', () => {
  for (const [info, algorithm] of [
    ['d4:name4:test6:pieces20:aaaaaaaaaaaaaaaaaaaae', 'sha1'],
    ['d12:meta versioni2e4:name4:teste', 'sha256'],
  ]) {
    const torrent = Buffer.from('d4:info' + info + 'e');
    assert.equal(torrentMetadataHash(torrent), createHash(algorithm!).update(info!).digest('hex'));
  }
});
test('rejects malformed, ambiguous, missing and oversized metadata', () => {
  for (const text of [
    'd4:info',
    'd4:infodee',
    'd4:infod6:pieces1:aee',
    'd4:infod6:pieces0:6:pieces0:ee',
    'd4:infod6:pieces0:eeTRAILING',
    'd4:infod12:meta versioni02eee',
  ]) {
    assert.throws(() => torrentMetadataHash(Buffer.from(text)), { code: 'INVALID_TORRENT_METADATA' });
  }
  assert.throws(() => torrentMetadataHash(Buffer.alloc(8 * 1024 * 1024 + 1)), { code: 'INVALID_TORRENT_METADATA' });
});
