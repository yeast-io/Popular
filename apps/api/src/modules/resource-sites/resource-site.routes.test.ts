import { siteAccountInUse, siteAccountIdentityPending } from './site-account.errors.js';
import { maskIntegrationSecret } from '@movie-hub/contract';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import { ResourceSiteService } from './resource-site.service.js';
import { HDAreaHttpClient } from '../../infrastructure/hdarea/hdarea-http.client.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import { HDAreaAdapter } from '../../infrastructure/hdarea/hdarea.adapter.js';
import type { ResourceSiteCredential } from './resource-site.types.js';

const config = loadConfig({
  NODE_ENV: 'test',
  WEB_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://db.example/movie_hub',
  REDIS_URL: 'redis://redis.example:6379',
  MINIO_ENDPOINT: 'minio.example',
  MINIO_ACCESS_KEY: 'access',
  MINIO_SECRET_KEY: 'secret',
  MINIO_BUCKET: 'avatars',
  SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
  INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters',
  TMDB_READ_ACCESS_TOKEN: 'test-token',
  ACCESS_LOG_ENABLED: 'false',
});

test('authenticated Cookie save → search → detail → delete runs through the real adapter and HTTP session', async () => {
  const rows = new Map<string, ResourceSiteCredential>();
  let requests = 0;
  const auth = {
    requireOwnerId: async (token?: string) => {
      if (token !== 'A' && token !== 'B') throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      return token;
    },
  } as AuthService;
  const sites = new ResourceSiteService(
    new Map([['hdarea', new HDAreaAdapter('https://hdarea.club/')]]),
    {
      find: async (owner) => rows.get(owner) ?? null,
      save: async (row) => {
        rows.set(row.ownerId, row);
      },
      invalidate: async () => {},
      delete: async (owner) => {
        rows.delete(owner);
      },
    },
    new SecretCrypto('test-resource-sites-secret-that-is-long-enough'),
    new HDAreaHttpClient({
      intervalMs: 0,
      fetch: async (input, init) => {
        requests++;
        const url = new URL(String(input));
        const cookie = new Headers(init?.headers).get('cookie');
        const id = cookie === 'uid=A-secret' ? '101' : '202';
        const account = `<a href="usercp.php">Account</a><div id="info_block"><a href="userdetails.php?id=${id}">Me</a></div>`;
        if (url.pathname === '/torrents.php')
          return new Response(
            account
            + `<table class="torrents"><tbody><tr><td><table class="torrentname"><tr><td><a href="details.php?id=${id}" title="Interstellar 2014">Film</a></td></tr></table></td><td></td><td></td><td>10 GiB</td><td>22</td><td></td><td></td><td></td></tr></tbody></table>`
          );
        return new Response(account + '<h1>Interstellar 2014</h1>');
      },
    }),
    { logger: { error() {} }, verbose: false }
  );
  const app = await buildApp({ config, healthDependencies: [], authService: auth, resourceSiteService: sites });
  try {
    const base = '/api/v1/me/integrations/resource-sites/hdarea';
    assert.equal((await app.inject({ method: 'GET', url: base })).statusCode, 401);
    assert.equal(requests, 0);
    for (const owner of ['A', 'B']) {
      const saved = await app.inject({
        method: 'PUT',
        url: base,
        headers: { cookie: `${config.SESSION_COOKIE_NAME}=${owner}` },
        payload: { cookie: `uid=${owner}-secret`, passkey: `passkey-${owner}-secret` },
      }
      );
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.body.includes(`uid=${owner}-secret`), false);
      assert.equal(saved.body.includes(`passkey-${owner}-secret`), false);
      assert.equal(saved.json().cookieMasked, maskIntegrationSecret(`uid=${owner}-secret`));
      assert.equal(saved.json().passkeyMasked, maskIntegrationSecret(`passkey-${owner}-secret`));
    }
    const a = { cookie: `${config.SESSION_COOKIE_NAME}=A` };
    const b = { cookie: `${config.SESSION_COOKIE_NAME}=B` };
    const [first, second] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/v1/me/resource-sites/hdarea/releases?query=Interstellar', headers: a }),
      app.inject({ method: 'GET', url: '/api/v1/me/resource-sites/hdarea/releases?imdbId=tt0816692', headers: b }),
    ]
    );
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(first.json().releases[0].id, '101');
    assert.equal(second.json().releases[0].id, '202');
    const detail = await app.inject({
      method: 'GET',
      url: '/api/v1/me/resource-sites/hdarea/releases/101',
      headers: a,
    }
    );
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().title, 'Interstellar 2014');
    const count = requests;
    for (const query of ['', '?query=%20', '?imdbId=invalid'])
      assert.equal(
        (await app.inject({ method: 'GET', url: '/api/v1/me/resource-sites/hdarea/releases' + query, headers: a }))
          .statusCode,
        400
      );
    assert.equal(requests, count);
    assert.equal((await app.inject({ method: 'DELETE', url: base, headers: a })).statusCode, 204);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/me/resource-sites/hdarea/releases?query=Film', headers: a }))
        .statusCode,
      409
    );
    assert.equal((await sites.configuration('B', 'hdarea')).status, 'configured_valid');
  } finally {
    await app.close();
  }
});

test('site account conflicts and pending legacy identities use safe localized HTTP errors', async () => {
  let error = siteAccountInUse(new Error('private-original-index'));
  const sites = new ResourceSiteService(
    new Map([['hdarea', new HDAreaAdapter('https://hdarea.club/')]]),
    {
      find: async () => null,
      save: async () => { throw error; },
      invalidate: async () => {},
      delete: async () => {},
    },
    new SecretCrypto('test-integration-key-at-least-32-characters'),
    new HDAreaHttpClient({ intervalMs: 0, fetch: async () => {
      return new Response('<a href="usercp.php">Account</a><div id="info_block"><a href="userdetails.php?id=123">Me</a></div>');
    } }),
    { logger: { error() {} }, verbose: false }
  );
  const app = await buildApp({ config, healthDependencies: [], resourceSiteService: sites,
    authService: { requireOwnerId: async () => 'A' } as unknown as AuthService });
  try {
    for (const language of ['en-US', 'zh-CN']) {
      for (const failure of [siteAccountInUse(new Error('private-original-index')), siteAccountIdentityPending()]) {
        error = failure;
        const response = await app.inject({
          method: 'PUT', url: '/api/v1/me/integrations/resource-sites/hdarea',
          headers: { 'accept-language': language }, payload: { cookie: 'session=private-cookie' },
        });
        assert.equal(response.statusCode, failure.statusCode);
        assert.equal(response.json().error.code, failure.code);
        assert.equal(response.body.includes('private-original-index'), false);
        assert.equal(response.body.includes('private-cookie'), false);
        if (language === 'zh-CN') assert.match(response.json().error.message, /站点账号/);
      }
    }
  } finally { await app.close(); }
});
