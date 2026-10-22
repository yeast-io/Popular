import assert from 'node:assert/strict';
import test from 'node:test';
import { HDAreaHttpClient } from './hdarea-http.client.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';

test('concurrent users have independent Cookie jars, including Set-Cookie updates', async () => {
  const seen: Array<{ path: string; cookie: string }> = [];
  const client = new HDAreaHttpClient({
    intervalMs: 0,
    fetch: async (input, init) => {
      const cookie = new Headers(init?.headers).get('cookie')!;
      seen.push({ path: String(input), cookie });
      return new Response('ok', {
        headers: { 'set-cookie': `session=${cookie.includes('uid=A') ? 'A' : 'B'}; Path=/; Secure` },
      });
    },
  });
  const [a, b] = await Promise.all([
    client.session('https://hdarea.club/', 'uid=A'),
    client.session('https://hdarea.club/', 'uid=B'),
  ]
  );
  await Promise.all([a.get('index.php'), b.get('index.php')]);
  await Promise.all([a.get('torrents.php'), b.get('torrents.php')]);
  assert.equal(seen[2]!.cookie, 'uid=A; session=A');
  assert.equal(seen[3]!.cookie, 'uid=B; session=B');
});
test('never forwards credentials across origins or follows a login redirect', async () => {
  let calls = 0;
  const client = new HDAreaHttpClient({
    intervalMs: 0,
    fetch: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
    },
  });
  const session = await client.session('https://hdarea.club/', 'uid=secret');
  await assert.rejects(session.get('index.php'), (e) => e instanceof ResourceSiteError && e.reason === 'blocked');
  assert.equal(calls, 1);
  await assert.rejects(session.get('https://evil.example/'), ResourceSiteError);
  assert.equal(calls, 1);
});
test('429 stops queued and subsequent requests, respecting a cooldown without retries', async () => {
  let calls = 0;
  const client = new HDAreaHttpClient({
    intervalMs: 0,
    fetch: async () => {
      calls++;
      return new Response(null, { status: 429, headers: { 'retry-after': '120' } });
    },
  });
  const session = await client.session('https://hdarea.club/', 'uid=A');
  const results = await Promise.allSettled([session.get('a'), session.get('b')]);
  assert.equal(
    results.every((r) => r.status === 'rejected'),
    true
  );
  assert.equal(calls, 1);
  await assert.rejects(session.get('c'), ResourceSiteError);
  assert.equal(calls, 1);
});
test('bounded bodies and cancellation reject without another network request', async () => {
  let calls = 0;
  const client = new HDAreaHttpClient({
    intervalMs: 0,
    maxBytes: 2,
    fetch: async () => {
      calls++;
      return new Response('too big');
    },
  });
  const session = await client.session('https://hdarea.club/', 'uid=A');
  await assert.rejects(session.get('a'), (e) => e instanceof ResourceSiteError && e.reason === 'invalidResponse');
  await assert.rejects(session.get('b', AbortSignal.abort()));
  assert.equal(calls, 1);
});
