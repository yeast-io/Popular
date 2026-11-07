import assert from 'node:assert/strict';
import test from 'node:test';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { AppError } from '../../infrastructure/http/app-error.js';
import { integrationSecretContext } from '../integrations/integration.service.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import { DownloadSourceService } from './download-source.service.js';

function fixture(options: { configured?: boolean; identity?: boolean; validationError?: Error } = {}) {
  const calls: string[] = [];
  const secrets = new SecretCrypto('download-source-test-secret-at-least-32-characters');
  const release = { id: '42', title: 'Film', seeders: 0, tags: [], detailsUrl: 'https://site.example/42' };
  const service = new DownloadSourceService({
    secrets,
    configs: {
      async find(ownerId, provider) {
        calls.push(`config:${ownerId}:${provider}`);
        return options.configured === false
          ? null
          : {
              ownerId, provider, baseUrl: 'https://mteam.example',
              ...(options.identity === false ? {} : { externalUserId: '123' }),
              encryptedApiKey: secrets.encrypt(`key:${ownerId}`, integrationSecretContext(ownerId, 'mteam')),
            };
      },
    },
    mteam: {
      async torrentUrl(baseUrl, key, id, context) {
        assert.equal(baseUrl, 'https://mteam.example');
        assert.equal(key, 'key:alice');
        assert.equal(id, '42');
        calls.push(`mteam-url:${context?.ownerId ?? 'remote'}`);
        return 'https://mteam.example/torrent?passkey=secret';
      },
    },
    resources: {
      async listReleases(ownerId, tmdbId) {
        calls.push(`local-movie:${ownerId}:${tmdbId}`);
        if (options.validationError) throw options.validationError;
        return { provider: 'mteam', availability: 'available', cached: false,
          queriedAt: new Date().toISOString(), releases: [release] };
      },
    },
    siteDownloads: {
      resources: {
        async releaseForDownload(ownerId, tmdbId, source, id) {
          calls.push(`movie:${ownerId}:${tmdbId}:${source}:${id}`);
          if (options.validationError) throw options.validationError;
          return release;
        },
      },
      sites: {
        async torrentUrl(ownerId, source, id) {
          calls.push(`site-url:${ownerId}:${source}:${id}`);
          return 'https://hdarea.example/torrent?passkey=secret';
        },
      },
    },
  });
  return { service, calls, release };
}

test('local preparation validates first and defers credential decryption and URL retrieval until the task is claimed', async () => {
  const f = fixture();
  const prepared = await f.service.prepareLocal({ ownerId: 'alice', tmdbId: 603, source: 'mteam', releaseId: '42', locale: 'en-US' });
  assert.equal(prepared.release, f.release);
  assert.deepEqual(f.calls, ['config:alice:mteam', 'local-movie:alice:603']);
  assert.equal(await prepared.torrentUrl(), 'https://mteam.example/torrent?passkey=secret');
  assert.equal(f.calls.at(-1), 'mteam-url:alice');
});

test('remote movie delivery revalidates before loading credentials and retrieving the URL', async () => {
  const f = fixture({ identity: false });
  const url = await f.service.resolveRemote({ ownerId: 'alice', tmdbId: 603, source: 'mteam', releaseId: '42' });
  assert.equal(url, 'https://mteam.example/torrent?passkey=secret');
  assert.deepEqual(f.calls, ['movie:alice:603:mteam:42', 'config:alice:mteam', 'mteam-url:remote']);
});

for (const source of ['hdarea', 'hdwing']) test(`local and remote ${source} downloads share site resolution without touching M-Team credentials`, async () => {
  const f = fixture();
  const request = { ownerId: 'alice', tmdbId: 603, source, releaseId: '42' };
  const prepared = await f.service.prepareLocal({ ...request, locale: 'zh-CN' });
  const localUrl = await prepared.torrentUrl();
  assert.equal(await f.service.resolveRemote(request), localUrl);
  assert.deepEqual(f.calls, [
    `movie:alice:603:${source}:42`, `site-url:alice:${source}:42`,
    `movie:alice:603:${source}:42`, `site-url:alice:${source}:42`,
  ]);
});

test('TV resources keep their pre-enqueue validation and do not require a movie identity', async () => {
  const f = fixture();
  const request = { ownerId: 'alice', source: 'hdarea', releaseId: '42' };
  const prepared = await f.service.prepareLocal({ ...request, resource: f.release, locale: 'en-US' });
  assert.equal(prepared.release, f.release);
  await prepared.torrentUrl();
  await f.service.resolveRemote(request);
  assert.deepEqual(f.calls, ['site-url:alice:hdarea:42', 'site-url:alice:hdarea:42']);
});

test('validation failures preserve the original error and never retrieve torrent URLs', async () => {
  const error = new ResourceSiteError('authentication');
  for (const source of ['mteam', 'hdarea', 'hdwing']) {
    const f = fixture({ validationError: error });
    const request = { ownerId: 'alice', tmdbId: 603, source, releaseId: '42' };
    await assert.rejects(f.service.prepareLocal({ ...request, locale: 'en-US' }), (actual) => actual === error);
    await assert.rejects(f.service.resolveRemote(request), (actual) => actual === error);
    assert.equal(f.calls.some((call) => call.includes('-url:')), false);
  }
});

test('missing M-Team configuration retains local HTTP and remote RPC error contracts', async () => {
  const f = fixture({ configured: false });
  const request = { ownerId: 'alice', tmdbId: 603, source: 'mteam', releaseId: '42' };
  for (const locale of ['en-US', 'zh-CN'] as const) {
    await assert.rejects(f.service.prepareLocal({ ...request, locale }), (error) =>
      error instanceof AppError && error.code === 'MTEAM_NOT_CONFIGURED' && error.statusCode === 409);
  }
  await assert.rejects(f.service.resolveRemote(request), (error) =>
    error instanceof RpcError && error.code === 'RESOURCE_SITE_NOT_CONFIGURED' && error.effect === 'not_applied');
});

test('local M-Team downloads still require an account identity before validating a resource', async () => {
  const f = fixture({ identity: false });
  await assert.rejects(f.service.prepareLocal({ ownerId: 'alice', tmdbId: 603, source: 'mteam', releaseId: '42', locale: 'en-US' }), {
    code: 'RESOURCE_SITE_IDENTITY_PENDING',
  });
  assert.deepEqual(f.calls, ['config:alice:mteam']);
});

test('local selection rejects a release absent from the validated movie results', async () => {
  const f = fixture();
  await assert.rejects(f.service.prepareLocal({ ownerId: 'alice', tmdbId: 603, source: 'mteam', releaseId: 'other', locale: 'en-US' }), {
    code: 'NOT_FOUND',
  });
  assert.equal(f.calls.some((call) => call.includes('-url:')), false);
});
