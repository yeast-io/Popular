import assert from 'node:assert/strict';
import test from 'node:test';
import { HDAreaAdapter } from './hdarea.adapter.js';

const bytes = (value: string) => Buffer.from(value);
const authenticated = '<a href="usercp.php">Account</a>';

test('search encodes keywords and translates one-based pages; IMDb takes priority', async () => {
  const paths: string[] = [];
  const adapter = new HDAreaAdapter('https://hdarea.example/');
  const session = {
    get: async (path: string) => {
      paths.push(path);
      return bytes(authenticated + '没有找到');
    },
  };
  await adapter.search(session, { query: '星际穿越 & 2014', page: 2 });
  let params = new URL(paths[0]!, adapter.baseUrl).searchParams;
  assert.equal(params.get('search'), '星际穿越 & 2014');
  assert.equal(params.get('page'), '1');
  await adapter.search(session, { query: 'ignored', imdbId: 'tt0816692' });
  params = new URL(paths[1]!, adapter.baseUrl).searchParams;
  assert.equal(params.get('search'), 'tt0816692');
});

test('extracts only the current torrent Cookie download link and deduplicates repeated buttons', async () => {
  const adapter = new HDAreaAdapter('https://hdarea.example/');
  const calls: string[] = [];
  const torrent = bytes('d4:infod4:name4:testee');
  const session = { get: async (path: string) => {
    calls.push(path);
    return path.startsWith('details.php')
      ? bytes(authenticated + '<a href="download.php?id=123">one</a><a href="download.php?id=123">two</a><a href="download.php?id=999">other</a><a href="download.php?id=123&amp;passkey=legacy">legacy</a>')
      : torrent;
  } };
  assert.equal(adapter.requiresPasskey, false);
  assert.deepEqual(await adapter.torrentFile(session, '123'), torrent);
  assert.deepEqual(calls, ['details.php?id=123', 'https://hdarea.example/download.php?id=123']);
});

test('rejects missing, foreign, mismatched and credential-bearing links before requesting torrent contents', async () => {
  const adapter = new HDAreaAdapter('https://hdarea.example/');
  for (const content of ['', '<a href="https://foreign.example/download.php?id=123">bad</a>',
    '<a href="download.php?id=999">other</a>', '<a href="download.php?id=123&amp;passkey=secret">legacy</a>',
    '<a href="download.php?id=123&amp;id=456">duplicate</a>', '<input type="password">']) {
    let calls = 0;
    await assert.rejects(adapter.torrentFile({ get: async () => {
      calls++;
      return bytes(authenticated + content);
    } }, '123'));
    assert.equal(calls, 1);
  }
});
