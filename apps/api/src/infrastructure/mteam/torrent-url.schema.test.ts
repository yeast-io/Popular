import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTorrentUrl } from './torrent-url.schema.js';

test('preserves the token URL and rejects missing, malformed, insecure or credential-bearing URLs', () => {
  const url = 'https://tracker.example/download.php?id=991&token=private-token';
  assert.equal(parseTorrentUrl({ data: url }), url);
  for (const data of [
    undefined,
    123,
    'invalid',
    'http://tracker.example/file',
    'https://user:secret@tracker.example/file',
  ]) {
    assert.throws(() => parseTorrentUrl({ data }), /invalid torrent URL/);
  }
});
