import { maskIntegrationSecret } from '@movie-hub/contract';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResourceSiteCredential, ResourceSiteCredentialStore } from './resource-site.types.js';
import { ResourceSiteService } from './resource-site.service.js';
import { createResourceSiteRegistry } from './resource-site.registry.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import { ResourceSiteHttpClient } from '../../infrastructure/resource-sites/resource-site-http.client.js';
import { ResourceSiteError } from './resource-site.errors.js';

function fixture() {
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
    createResourceSiteRegistry('https://hdarea.club/'),
    store,
    new SecretCrypto('test-key-at-least-thirty-two-characters'),
    new ResourceSiteHttpClient({
      intervalMs: 0,
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('cookie')!);
        return new Response(expired ? '<input type="password">' : '<a href="usercp.php">Account</a><p>没有找到</p>');
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
  await f.service.configure('A', 'hdarea', 'uid=A; session=secretA');
  await f.service.configure('B', 'hdarea', 'uid=B; session=secretB');
  assert.equal(f.rows.get('A:hdarea')!.encryptedCookie.includes('secretA'), false);
  assert.equal(JSON.stringify(await f.service.configuration('A', 'hdarea')).includes('secretA'), false);
  await Promise.all([
    f.service.search('A', 'hdarea', { query: 'Film' }),
    f.service.search('B', 'hdarea', { query: 'Film' }),
  ]
  );
  assert.equal(f.seen[2], 'uid=A; session=secretA');
  assert.equal(f.seen[3], 'uid=B; session=secretB');
  await f.service.configure('A', 'hdarea', 'uid=A2');
  await f.service.search('A', 'hdarea', { query: 'Film' });
  assert.equal(f.seen.at(-1), 'uid=A2');
  await f.service.delete('A', 'hdarea');
  await assert.rejects(
    f.service.search('A', 'hdarea', { query: 'Film' }),
    (e) => e instanceof ResourceSiteError && e.reason === 'notConfigured'
  );
});
test('authentication failure stops later requests until the user replaces or revalidates Cookie', async () => {
  const f = fixture();
  await f.service.configure('A', 'hdarea', 'uid=secretA');
  f.expire();
  await assert.rejects(f.service.search('A', 'hdarea', { query: 'Film' }), ResourceSiteError);
  const calls = f.seen.length;
  await assert.rejects(f.service.search('A', 'hdarea', { query: 'Film' }), ResourceSiteError);
  assert.equal(f.seen.length, calls);
  assert.equal((await f.service.configuration('A', 'hdarea')).status, 'configured_invalid');
  assert.equal(JSON.stringify(f.logs).includes('secretA'), false);
  assert.equal(f.logs.length > 0, true);
});

test('Passkey is encrypted, masked, retained on Cookie replacement, and used only by the backend URL builder', async () => {
  const f = fixture();
  const saved = await f.service.configure('A', 'hdarea', 'uid=A', 'private-passkey-123');
  assert.equal(saved.cookieMasked, maskIntegrationSecret('uid=A'));
  assert.equal(saved.passkeyMasked, maskIntegrationSecret('private-passkey-123'));
  assert.equal(JSON.stringify(saved).includes('private-passkey'), false);
  const encrypted = f.rows.get('A:hdarea')!.encryptedPasskey!;
  assert.ok(encrypted);
  assert.equal(encrypted.includes('private-passkey'), false);
  const url = new URL(await f.service.torrentUrl('A', 'hdarea', '430912'));
  assert.equal(url.origin + url.pathname, 'https://hdarea.club/download.php');
  assert.equal(url.searchParams.get('id'), '430912');
  assert.equal(url.searchParams.get('passkey'), 'private-passkey-123');
  await f.service.configure('A', 'hdarea', saved.cookieMasked, saved.passkeyMasked);
  assert.equal(f.seen.at(-1), 'uid=A');
  assert.equal(f.rows.get('A:hdarea')!.encryptedPasskey, encrypted);
  await f.service.configure('A', 'hdarea', 'uid=A2');
  assert.equal(f.rows.get('A:hdarea')!.encryptedPasskey, encrypted);
  await f.service.configure('A', 'hdarea', undefined, 'new-passkey');
  assert.equal(new URL(await f.service.torrentUrl('A', 'hdarea', '430912')).searchParams.get('passkey'), 'new-passkey');
  await assert.rejects(
    f.service.torrentUrl('B', 'hdarea', '430912'),
    (e) => e instanceof ResourceSiteError && e.reason === 'notConfigured'
  );
  await assert.rejects(f.service.torrentUrl('A', 'hdarea', '../bad'), ResourceSiteError);
});
test('unchanged masks cannot create credentials and edited masks are rejected before external requests', async () => {
  const f = fixture();
  await assert.rejects(f.service.configure('A', 'hdarea', '••••••••'), ResourceSiteError);
  await assert.rejects(f.service.configure('A', 'hdarea', '••••••••extra'));
  assert.equal(f.seen.length, 0);
});

test('torrent URLs require valid owner credentials without fetching torrent content', async () => {
  const f = fixture();
  await f.service.configure('A', 'hdarea', 'uid=owner', 'owner-passkey');
  const before = f.seen.length;
  const url = new URL(await f.service.torrentUrl('A', 'hdarea', '123'));
  assert.equal(url.searchParams.get('passkey'), 'owner-passkey');
  assert.equal(f.seen.length, before);
  f.rows.get('A:hdarea')!.status = 'configured_invalid';
  await assert.rejects(
    f.service.torrentUrl('A', 'hdarea', '123'),
    (error) => error instanceof ResourceSiteError && error.reason === 'authentication'
  );
  assert.equal(f.seen.length, before);
  await assert.rejects(
    f.service.torrentUrl('missing', 'hdarea', '123'),
    (error) => error instanceof ResourceSiteError && error.reason === 'notConfigured'
  );
});
