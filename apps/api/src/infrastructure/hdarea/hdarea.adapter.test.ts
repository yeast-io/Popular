import assert from 'node:assert/strict';
import test from 'node:test';
import { HDAreaAdapter } from './hdarea.adapter.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';

const bytes = (data: unknown) => Buffer.from(JSON.stringify({ success: true, code: 0, data }));
const adapter = new HDAreaAdapter('https://hdarea.example/');

test('REST search encodes queries, maps pages and uses has_more instead of the estimated total', async () => {
  const calls: string[] = [];
  const session = {
    get: async (path: string) => {
      calls.push(path);
      const params = new URL(path, adapter.baseUrl).searchParams;
      return bytes({
        items: [{ id: 123, name: 'Movie 1080p', imdb_id: 'tt0816692', seeders: 0 }],
        pagination: { page: Number(params.get('page')), has_more: true, total: 3 },
      });
    },
  };
  const result = await adapter.search(session, { query: '星际穿越 & 2014', page: 2, mediaType: 'movie' });
  const url = new URL(calls[0]!, adapter.baseUrl);
  assert.equal(url.pathname, '/api/v1/torrents');
  assert.equal(url.searchParams.get('q'), '星际穿越 & 2014');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(url.searchParams.has('cat'), false);
  assert.equal(result.nextPage, 3);
  assert.equal(result.releases[0]?.seeders, 0);
  await adapter.search(session, { query: 'ignored', imdbId: 'tt0816692', mediaType: 'tv' });
  const imdb = new URL(calls[1]!, adapter.baseUrl).searchParams;
  assert.equal(imdb.get('imdb'), 'tt0816692');
  assert.equal(imdb.has('q'), false);
  assert.equal(imdb.has('cat'), false);
});

test('profile and detail require exact valid identities; malformed and unrelated results fail closed', async () => {
  assert.equal(await adapter.verify({ get: async () => bytes({ id: 123 }) }), '123');
  for (const id of [0, -1, null, 'not-id']) await assert.rejects(adapter.verify({ get: async () => bytes({ id }) }));
  assert.equal((await adapter.detail({ get: async () => bytes({ id: 123, name: 'Movie' }) }, '123')).id, '123');
  await assert.rejects(adapter.detail({ get: async () => bytes({ id: 456, name: 'Other' }) }, '123'));
  await assert.rejects(
    adapter.search(
      {
        get: async () =>
          bytes({ items: [{ id: 1, name: 'Other', imdb_id: 'tt0000001' }], pagination: { page: 0, has_more: false } }),
      },
      { imdbId: 'tt0816692' }
    )
  );
});

test('downloads through a short-lived token and refreshes an expired token once', async () => {
  let issued = 0;
  let reads = 0;
  const torrent = Buffer.from('d4:infod4:name4:testee');
  const session = {
    post: async (path: string, body: Record<string, unknown>) => {
      assert.equal(path, '/api/v1/torrents/genDlToken');
      assert.deepEqual(body, { id: '123' });
      return bytes({
        id: 123,
        expires_in: 1800,
        download_url: `https://hdarea.example/download.php?id=123&dl_token=short-${++issued}`,
      });
    },
    get: async (path: string) => {
      assert.match(path, /dl_token=short-/);
      if (++reads === 1) throw new ResourceSiteError('downloadExpired');
      return torrent;
    },
  };
  assert.deepEqual(await adapter.torrentFile(session, '123'), torrent);
  assert.equal(issued, 2);
  assert.equal(reads, 2);
});

test('rejects foreign, mismatched and permanent-credential download URLs before fetching', async () => {
  for (const url of [
    'https://foreign.example/download.php?id=123&dl_token=x',
    'https://hdarea.example/download.php?id=999&dl_token=x',
    'https://hdarea.example/download.php?id=123&dl_token=x&apikey=secret',
    'https://hdarea.example/download.php?id=123&dl_token=x&passkey=secret',
    'https://hdarea.example/download.php?id=123&id=123&dl_token=x',
    'https://hdarea.example/download.php?id=123',
  ]) {
    let reads = 0;
    await assert.rejects(
      adapter.torrentFile(
        {
          get: async () => {
            reads++;
            return Buffer.alloc(0);
          },
          post: async () => bytes({ id: 123, expires_in: 1800, download_url: url }),
        },
        '123'
      )
    );
    assert.equal(reads, 0);
  }
});
