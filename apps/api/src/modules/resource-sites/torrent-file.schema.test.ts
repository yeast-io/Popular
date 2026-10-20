import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTorrentFile } from './torrent-file.schema.js';
import { ResourceSiteError } from './resource-site.errors.js';

test('validates a complete bencoded torrent and rejects site errors, truncation and invalid info', () => {
  validateTorrentFile(Buffer.from('d4:infod4:name4:testee'));
  for (const body of ['<html>login required</html>', '{"error":"expired"}', 'd4:info4:teste', 'd4:infod4:name4:test', 'd4:infodeejunk', 'de', 'd4:infod1:ai-0eee']) {
    assert.throws(() => validateTorrentFile(Buffer.from(body)), ResourceSiteError);
  }
});
