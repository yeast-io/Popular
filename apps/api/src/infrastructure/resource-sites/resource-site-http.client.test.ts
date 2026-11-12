import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceSiteHttpClient } from './resource-site-http.client.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';

for (const kind of ['cookie', 'api', 'download'] as const) {
  test(`${kind} transport follows five redirects and rejects the sixth before sending it`, async () => {
    for (const hops of [5, 6]) {
      let calls = 0;
      const client = new ResourceSiteHttpClient({ intervalMs: 0, fetch: async (_url, init) => {
        calls++;
        if (kind === 'download') assert.equal(new Headers(init?.headers).has('x-api-key'), false);
        return calls <= hops
          ? new Response(null, { status: 302, headers: { location: `${kind === 'api' ? '/api/v1/' : '/'}hop-${calls}` } })
          : new Response('ok');
      } });
      const session = kind === 'cookie'
        ? await client.session('https://site.example/', 'uid=secret')
        : await client.apiSession('https://site.example/', 'a'.repeat(32));
      const result = session.get(kind === 'api' ? '/api/v1/status' : kind === 'download' ? '/download.php?id=42&dl_token=short' : '/start');
      if (hops === 5) assert.equal(Buffer.from(await result).toString(), 'ok');
      else await assert.rejects(result, { reason: 'redirected' });
      assert.equal(calls, 6);
    }
  });
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`API ${status} redirects preserve credentials and use the correct method and body`, async () => {
    const seen: RequestInit[] = [];
    const session = await new ResourceSiteHttpClient({ intervalMs: 0, fetch: async (_url, init) => {
      seen.push(init!);
      return seen.length === 1
        ? new Response(null, { status, headers: { location: '/api/v1/next' } })
        : new Response('ok');
    } }).apiSession('https://site.example/', 'a'.repeat(32));
    await session.post!('/api/v1/torrents/genDlToken', { id: '42' });
    assert.equal(new Headers(seen[1]!.headers).get('x-api-key'), 'a'.repeat(32));
    assert.equal(seen[0]!.signal, seen[1]!.signal);
    assert.equal(seen[1]!.method, status === 307 || status === 308 ? 'POST' : 'GET');
    assert.equal(seen[1]!.body, status === 307 || status === 308 ? '{"id":"42"}' : undefined);
    assert.equal(new Headers(seen[1]!.headers).has('content-type'), status === 307 || status === 308);
  });
}

test('Cookie redirects apply Set-Cookie before the next request', async () => {
  const seen: string[] = [];
  const session = await new ResourceSiteHttpClient({ intervalMs: 0, fetch: async (_url, init) => {
    seen.push(new Headers(init!.headers).get('cookie')!);
    return seen.length === 1
      ? new Response(null, { status: 302, headers: {
          'location': '/next', 'set-cookie': 'session=ROTATED; Path=/; Secure',
        } })
      : new Response('ok');
  } }).session('https://site.example/', 'uid=PRIVATE; session=OLD');
  await session.get('/start');
  assert.equal(seen[0], 'uid=PRIVATE; session=OLD');
  assert.equal(seen[1], 'uid=PRIVATE; session=ROTATED');
});

for (const kind of ['cookie', 'api', 'download'] as const) {
  test(`${kind} redirects reject loops, missing locations, invalid destinations and login pages`, async () => {
    for (const location of [undefined, '/start', '/login.php', '/captcha', 'http://site.example/file',
      'https://user:PRIVATE@site.example/file', '/file#PRIVATE', ...(kind === 'download' ? [] : ['https://cdn.example/file'])]) {
      let calls = 0;
      const client = new ResourceSiteHttpClient({ intervalMs: 0, fetch: async () => {
        calls++;
        return new Response(null, { status: 302, headers: location === undefined ? {} : { location } });
      } });
      const session = kind === 'cookie'
        ? await client.session('https://site.example/', 'uid=PRIVATE')
        : await client.apiSession('https://site.example/', 'a'.repeat(32));
      await assert.rejects(session.get(kind === 'api' ? '/api/v1/status' : kind === 'download' ? '/download.php?id=42&dl_token=short' : '/start'));
      // /start takes two responses in API/download mode before the visited-URL guard fires.
      assert.equal(calls, location === '/start' && kind !== 'cookie' ? 2 : 1);
    }
  });
}

test('credential-free download redirects allow an HTTPS CDN without attaching API credentials or cookies', async () => {
  const seen: string[] = [];
  const session = await new ResourceSiteHttpClient({ intervalMs: 0, fetch: async (url, init) => {
    seen.push(String(url));
    assert.equal(new Headers(init?.headers).has('x-api-key'), false);
    assert.equal(new Headers(init?.headers).has('cookie'), false);
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/file' } }) : new Response('ok');
  } }).apiSession('https://site.example/', 'a'.repeat(32));
  await session.get('/download.php?id=42&dl_token=short');
  assert.equal(seen[1], 'https://cdn.example/file');
});

test('concurrent users have independent Cookie jars, including Set-Cookie updates', async () => {
  const seen: Array<{ path: string; cookie: string }> = [];
  const client = new ResourceSiteHttpClient({
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
  ]);
  await Promise.all([a.get('index.php'), b.get('index.php')]);
  await Promise.all([a.get('torrents.php'), b.get('torrents.php')]);
  assert.equal(seen[2]!.cookie, 'uid=A; session=A');
  assert.equal(seen[3]!.cookie, 'uid=B; session=B');
});
test('never forwards credentials across origins or follows a login redirect', async () => {
  let calls = 0;
  const client = new ResourceSiteHttpClient({
    intervalMs: 0,
    fetch: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
    },
  });
  const session = await client.session('https://hdarea.club/', 'uid=secret');
  await assert.rejects(session.get('index.php'), (e) => e instanceof ResourceSiteError && e.reason === 'redirected');
  assert.equal(calls, 1);
  await assert.rejects(session.get('https://evil.example/'), ResourceSiteError);
  assert.equal(calls, 1);
});
test('429 stops queued and subsequent requests, respecting a cooldown without retries', async () => {
  let calls = 0;
  const client = new ResourceSiteHttpClient({
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
  const client = new ResourceSiteHttpClient({
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

test('API requests isolate keys per owner and never attach permanent credentials to downloads', async () => {
  const seen: Array<{ url: string; headers: Headers; method: string | undefined }> = [];
  const client = new ResourceSiteHttpClient({
    intervalMs: 0,
    fetch: async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers), method: init?.method });
      return new Response('ok', { headers: { 'set-cookie': 'session=must-not-be-used; Secure' } });
    },
  });
  const a = await client.apiSession('https://hdarea.example/', 'a'.repeat(32));
  const b = await client.apiSession('https://hdarea.example/', 'b'.repeat(32));
  await Promise.all([a.get('/api/v1/user/profile'), b.get('/api/v1/torrents')]);
  await a.post!('/api/v1/torrents/genDlToken', { id: '123' });
  await a.get('/download.php?id=123&dl_token=short');
  assert.equal(seen[0]!.headers.get('x-api-key'), 'a'.repeat(32));
  assert.equal(seen[1]!.headers.get('x-api-key'), 'b'.repeat(32));
  assert.equal(seen[2]!.method, 'POST');
  assert.equal(seen[3]!.headers.has('x-api-key'), false);
  assert.ok(seen.every((r) => !r.headers.has('cookie') && !r.url.includes('apikey=')));
  await assert.rejects(a.get('https://foreign.example/api/v1/status'));
  assert.equal(seen.length, 4);
});

test('API transport handles HTML errors, 403, redirects, limits and oversized bodies without leaking credentials', async () => {
  for (const [status, reason] of [
    [403, 'authentication'],
    [404, 'invalidResponse'],
    [302, 'redirected'],
    [429, 'rateLimited'],
  ] as const) {
    let calls = 0;
    const client = new ResourceSiteHttpClient({
      intervalMs: 0,
      fetch: async () => {
        calls++;
        return new Response('<html>error</html>', {
          status,
          headers: { 'Retry-After': '120', 'location': 'https://foreign.example/' },
        });
      },
    });
    const session = await client.apiSession('https://hdarea.example/', 'a'.repeat(32));
    await assert.rejects(session.get('/api/v1/status'), (e) => e instanceof ResourceSiteError && e.reason === reason);
    if (status === 429) {
      await assert.rejects(session.get('/api/v1/status'));
      assert.equal(calls, 1);
    }
    if (status === 302) assert.equal(calls, 1);
  }
  const large = await new ResourceSiteHttpClient({ maxBytes: 2, fetch: async () => new Response('long') }).apiSession(
    'https://hdarea.example/',
    'a'.repeat(32)
  );
  await assert.rejects(
    large.get('/api/v1/status'),
    (e) => e instanceof ResourceSiteError && e.reason === 'invalidResponse'
  );
});
