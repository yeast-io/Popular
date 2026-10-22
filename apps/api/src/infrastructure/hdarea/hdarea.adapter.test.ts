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
