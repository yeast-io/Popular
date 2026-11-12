import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResourceSiteCredential, ResourceSiteCredentialStore } from './resource-site.types.js';
import { ResourceSiteService } from './resource-site.service.js';
import { HDWingAdapter } from '../../infrastructure/hdwing/hdwing.adapter.js';
import type { ResourceSiteAdapter } from './resource-site.types.js';
import { HDAreaAdapter } from '../../infrastructure/hdarea/hdarea.adapter.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import { ResourceSiteHttpClient } from '../../infrastructure/resource-sites/resource-site-http.client.js';
import { ResourceSiteError } from './resource-site.errors.js';

function fixture(site = 'hdarea') {
  const rows = new Map<string, ResourceSiteCredential>();
  const seen: string[] = [];
  const logs: unknown[] = [];
  let expired = false;
  const store: ResourceSiteCredentialStore = {
    find: async (owner, site) => rows.get(`${owner}:${site}`) ?? null,
    save: async (row) => {
      rows.set(`${row.ownerId}:${row.site}`, row);
    },
    invalidate: async (owner, site, version) => {
      const row = rows.get(`${owner}:${site}`);
      if (row?.version === version) row.status = 'configured_invalid';
    },
    delete: async (owner, site) => {
      rows.delete(`${owner}:${site}`);
    },
  };
  const service = new ResourceSiteService(
    new Map<string, ResourceSiteAdapter>([
      [site, site === 'hdwing' ? new HDWingAdapter('https://hdwing.org/') : new HDAreaAdapter('https://hdarea.club/')],
    ]),
    store,
    new SecretCrypto('test-key-at-least-thirty-two-characters'),
    new ResourceSiteHttpClient({
      intervalMs: 0,
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('x-api-key') ?? new Headers(init?.headers).get('cookie') ?? '');
        const url = new URL(String(_input));
        if (site === 'hdarea' && url.pathname.startsWith('/api/')) {
          if (expired) return Response.json({ success: false, code: 403 }, { status: 403 });
          const id = new Headers(init?.headers).get('x-api-key') === 'b'.repeat(32) ? '202' : '101';
          const data = url.pathname.endsWith('/profile')
            ? { id }
            : url.pathname.endsWith('/genDlToken')
              ? {
                  id: JSON.parse(String(init?.body)).id,
                  expires_in: 1800,
                  download_url: `https://hdarea.club/download.php?id=${JSON.parse(String(init?.body)).id}&dl_token=short`,
                }
              : { items: [], pagination: { page: 0, has_more: false } };
          return Response.json({ success: true, code: 0, data });
        }
        if (new URL(String(_input)).pathname === '/download.php' && !expired)
          return new Response('d4:infod4:name4:testee');
        const id = new Headers(init?.headers).get('cookie')?.includes('uid=B') ? '202' : '101';
        return new Response(
          expired
            ? '<input type="password">'
            : `<a href="usercp.php">Account</a><div id="info_block"><a href="userdetails.php?id=${id}">Me</a></div><div id="site_header"><div class="userinfo"><a href="userdetails.php?id=${id}">Me</a></div></div><div id="site_content"><p>没有找到</p><a href="download.php?id=${new URL(String(_input)).searchParams.get('id')}">Cookie download</a><a href="download.php?hash=${Buffer.from(`1\n42\n${id}`).toString('base64url')}.signature&amp;uid=${id}">Download</a></div>`
        );
      },
    }),
    {
      logger: {
        error: (...args: unknown[]) => {
          logs.push(args);
        },
      },
      verbose: false,
    }
  );
  return {
    service,
    rows,
    seen,
    logs,
    expire: () => {
      expired = true;
    },
  };
}
test('credentials are encrypted and associated with owner; replacement, test and delete work', async () => {
  const f = fixture();
  await f.service.configure('A', 'hdarea', undefined, undefined, 'a'.repeat(32));
  await f.service.configure('B', 'hdarea', undefined, undefined, 'b'.repeat(32));
  assert.equal(f.rows.get('A:hdarea')!.encryptedApiKey!.includes('a'.repeat(32)), false);
  assert.equal(JSON.stringify(await f.service.configuration('A', 'hdarea')).includes('secretA'), false);
  await Promise.all([
    f.service.search('A', 'hdarea', { query: 'Film' }),
    f.service.search('B', 'hdarea', { query: 'Film' }),
  ]);
  assert.equal(f.seen[2], 'a'.repeat(32));
  assert.equal(f.seen[3], 'b'.repeat(32));
  await f.service.configure('A', 'hdarea', undefined, undefined, 'a'.repeat(32));
  await f.service.search('A', 'hdarea', { query: 'Film' });
  assert.equal(f.seen.at(-1), 'a'.repeat(32));
  await f.service.delete('A', 'hdarea');
  await assert.rejects(
    f.service.search('A', 'hdarea', { query: 'Film' }),
    (e) => e instanceof ResourceSiteError && e.reason === 'notConfigured'
  );
});
test('authentication failure stops later requests until the user replaces or revalidates API Key', async () => {
  const f = fixture();
  await f.service.configure('A', 'hdarea', undefined, undefined, 'a'.repeat(32));
  f.expire();
  await assert.rejects(f.service.search('A', 'hdarea', { query: 'Film' }), ResourceSiteError);
  const calls = f.seen.length;
  await assert.rejects(f.service.search('A', 'hdarea', { query: 'Film' }), ResourceSiteError);
  assert.equal(f.seen.length, calls);
  assert.equal((await f.service.configuration('A', 'hdarea')).status, 'configured_invalid');
  assert.equal(JSON.stringify(f.logs).includes('secretA'), false);
  assert.equal(f.logs.length > 0, true);
});

test('HDArea downloads validated torrent bytes with a short-lived token and no permanent credentials', async () => {
  const f = fixture();
  const saved = await f.service.configure('A', 'hdarea', undefined, undefined, 'a'.repeat(32));
  assert.equal(saved.requiresPasskey, false);
  assert.equal(saved.passkeyMasked, undefined);
  const source = await f.service.torrentUrl('A', 'hdarea', '430912');
  assert.deepEqual(source, { metainfo: Buffer.from('d4:infod4:name4:testee').toString('base64') });
  assert.equal(f.seen.at(-1), '');
  await f.service.configure('A', 'hdarea', undefined, undefined, 'a'.repeat(32));
  await f.service.torrentUrl('A', 'hdarea', '430912');
  assert.equal(f.seen.at(-1), '');
  await assert.rejects(f.service.torrentUrl('B', 'hdarea', '430912'), ResourceSiteError);
  await assert.rejects(f.service.torrentUrl('A', 'hdarea', '../bad'), ResourceSiteError);
});
test('unchanged masks cannot create credentials and edited masks are rejected before external requests', async () => {
  const f = fixture();
  await assert.rejects(f.service.configure('A', 'hdarea', undefined, undefined, '••••••••'), ResourceSiteError);
  await assert.rejects(f.service.configure('A', 'hdarea', undefined, undefined, '••••••••extra'));
  assert.equal(f.seen.length, 0);
});

test('torrent files require valid owner credentials and stop after API Key expiry', async () => {
  const f = fixture();
  await f.service.configure('A', 'hdarea', undefined, undefined, 'a'.repeat(32));
  const before = f.seen.length;
  assert.equal(typeof (await f.service.torrentUrl('A', 'hdarea', '123')), 'object');
  assert.equal(f.seen.length, before + 2);
  f.rows.get('A:hdarea')!.status = 'configured_invalid';
  await assert.rejects(
    f.service.torrentUrl('A', 'hdarea', '123'),
    (error) => error instanceof ResourceSiteError && error.reason === 'authentication'
  );
  assert.equal(f.seen.length, before + 2);
  await assert.rejects(
    f.service.torrentUrl('missing', 'hdarea', '123'),
    (error) => error instanceof ResourceSiteError && error.reason === 'notConfigured'
  );
});

test('unresolved legacy identity is shown as invalid and cannot search, fetch details or download', async () => {
  const f = fixture();
  await f.service.configure('A', 'hdarea', undefined, undefined, 'a'.repeat(32));
  delete f.rows.get('A:hdarea')!.externalUserId;
  const calls = f.seen.length;
  const pending = (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === 'RESOURCE_SITE_IDENTITY_PENDING';
  assert.equal(await f.service.status('A', 'hdarea'), 'configured_invalid');
  assert.equal((await f.service.configuration('A', 'hdarea')).status, 'configured_invalid');
  await assert.rejects(f.service.search('A', 'hdarea', { query: 'Film' }), pending);
  await assert.rejects(f.service.detail('A', 'hdarea', '42'), pending);
  await assert.rejects(f.service.torrentUrl('A', 'hdarea', '42'), pending);
  assert.equal(f.seen.length, calls);
  await f.service.configure('A', 'hdarea');
  assert.equal(await f.service.status('A', 'hdarea'), 'configured_valid');
});

test('HDWing resolves links through owner Cookie sessions without a Passkey and invalidates expired sessions', async () => {
  const f = fixture('hdwing');
  const config = await f.service.configure('A', 'hdwing', 'uid=A; session=private-hdwing-cookie');
  assert.equal(config.requiresPasskey, false);
  assert.equal(config.passkeyMasked, undefined);
  const before = f.seen.length;
  const url = new URL(await f.service.torrentUrl('A', 'hdwing', '42'));
  assert.equal(url.searchParams.get('uid'), '101');
  assert.equal(f.seen.length, before + 1);
  assert.equal(f.seen.at(-1), 'uid=A; session=private-hdwing-cookie');
  f.expire();
  await assert.rejects(f.service.torrentUrl('A', 'hdwing', '42'), ResourceSiteError);
  assert.equal(await f.service.status('A', 'hdwing'), 'configured_invalid');
  assert.equal(JSON.stringify(f.logs).includes('private-hdwing-cookie'), false);
});

test('legacy HDArea Cookies are never reused and an explicit API Key replacement creates a new cache version', async () => {
  const f = fixture();
  const crypto = new SecretCrypto('test-key-at-least-thirty-two-characters');
  f.rows.set('A:hdarea', {
    ownerId: 'A',
    site: 'hdarea',
    externalUserId: '101',
    encryptedCookie: crypto.encrypt('uid=A; session=legacy-private', 'movie-hub:resource-site:hdarea:owner:A'),
    version: 'legacy',
    status: 'configured_valid',
    verifiedAt: new Date(),
  });
  const config = await f.service.configuration('A', 'hdarea');
  assert.equal(config.status, 'configured_invalid');
  assert.equal(config.credentialUpdateRequired, true);
  assert.equal(config.cookieMasked, undefined);
  assert.equal(config.apiKeyMasked, undefined);
  await assert.rejects(
    f.service.configure('A', 'hdarea'),
    (e) => e instanceof ResourceSiteError && e.reason === 'apiKeyRequired'
  );
  await assert.rejects(
    f.service.search('A', 'hdarea', { query: 'Movie' }),
    (e) => e instanceof ResourceSiteError && e.reason === 'apiKeyRequired'
  );
  assert.equal(f.seen.length, 0);
  await assert.rejects(f.service.configure('A', 'hdarea', 'uid=A'), ResourceSiteError);
  const next = await f.service.configure('A', 'hdarea', undefined, undefined, 'a'.repeat(32));
  assert.equal(next.status, 'configured_valid');
  assert.equal(next.credentialUpdateRequired, undefined);
  assert.equal(f.rows.get('A:hdarea')!.encryptedCookie, undefined);
  assert.notEqual(await f.service.cacheVersion('A', 'hdarea'), 'legacy');
});
