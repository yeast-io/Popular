import assert from 'node:assert/strict';
import test from 'node:test';
import { HDWingAdapter } from './hdwing.adapter.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';

const header = '<div id="site_header"><div class="userinfo"><a href="userdetails.php?id=123">Me</a></div></div>';
test('uses explicit IMDb search and all categories, preserves dead torrents, and maps pages', async () => {
  const paths: string[] = [];
  const adapter = new HDWingAdapter('https://hdwing.org/');
  const session = { get: async (path: string) => {
    paths.push(path);
    return Buffer.from(header + '<div id="site_content">没有找到</div>');
  } };
  assert.equal(await adapter.verify(session), '123');
  await adapter.search(session, { imdbId: 'tt1234567', query: 'ignored', page: 2 });
  const params = new URL(paths[1]!, adapter.baseUrl).searchParams;
  assert.equal(params.get('search'), 'tt1234567');
  assert.equal(params.get('search_area'), '4');
  assert.equal(params.get('allsec'), '1');
  assert.equal(params.get('incldead'), '0');
  assert.equal(params.get('page'), '1');
  assert.equal(params.has('csrf'), false);
  await adapter.search(session, { query: ' 中文 & Movie ' });
  assert.equal(new URL(paths[2]!, adapter.baseUrl).searchParams.get('search'), '中文 & Movie');
  assert.equal(new URL(paths[2]!, adapter.baseUrl).searchParams.get('search_area'), '0');
  await assert.rejects(adapter.detail(session, '../bad'), ResourceSiteError);
  assert.equal(paths.length, 3);
});

test('fetches a fresh signed link for every delivery without requiring a Passkey', async () => {
  let calls = 0;
  const adapter = new HDWingAdapter('https://hdwing.org/');
  const session = { get: async (path: string) => {
    calls++;
    assert.equal(path, 'details.php?id=42');
    const hash = `${Buffer.from('1\n42\n123').toString('base64url')}.signature${calls}`;
    return Buffer.from(header + `<div id="site_content"><a href="download.php?hash=${hash}&amp;uid=123">Download</a></div>`);
  } };
  assert.equal(adapter.requiresPasskey, false);
  assert.notEqual(await adapter.resolveTorrentUrl(session, '42', '123'), await adapter.resolveTorrentUrl(session, '42', '123'));
  assert.equal(calls, 2);
});
