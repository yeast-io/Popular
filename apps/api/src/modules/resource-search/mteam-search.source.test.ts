import assert from 'node:assert/strict';
import test from 'node:test';
import { MTeamSearchSource } from './mteam-search.source.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import { integrationSecretContext } from '../integrations/integration.service.js';
import type { IntegrationConfigStore } from '../integrations/integration.types.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';

const secrets = new SecretCrypto('test-resource-search-secret-at-least-32-characters');
const configs = {
  find: async (owner: string) => {
    return {
      ownerId: owner,
      provider: 'mteam',
      baseUrl: 'https://api.m-team.cc',
      externalUserId: '101',
      encryptedApiKey: secrets.encrypt(`key-${owner}`, integrationSecretContext(owner, 'mteam')),
      verifiedAt: new Date(),
    };
  },
} satisfies Pick<IntegrationConfigStore, 'find'>;
test('M-Team uses the authenticated owner key, keyword/IMDb query and native source page', async () => {
  const source = new MTeamSearchSource(
    configs,
    secrets,
    {
      searchMoviePage: async (_base, key, query, context, options) => {
        assert.equal(key, 'key-A');
        assert.equal(context?.ownerId, 'A');
        assert.deepEqual(query, { imdbId: 'tt0816692' });
        assert.equal(options?.page, 3);
        assert.ok(options?.signal);
        return {
          releases: [
            { id: '42', title: 'Film', visible: true, banned: false, seeders: 2 },
            { id: '43', title: 'Banned', visible: true, banned: true, seeders: 2 },
          ],
          nextPage: 4,
        };
      },
    },
    0
  );
  const result = await source.search(
    'A',
    { imdbId: 'tt0816692', query: 'ignored', page: 3 },
    new AbortController().signal
  );
  assert.deepEqual(result, { releases: [{ id: '42', title: 'Film', seeders: 2 }], nextPage: 4 });
  assert.equal(JSON.stringify(result).includes('key-A'), false);
});
test('M-Team protects each account from concurrent searches and cancellation never starts a call', async () => {
  let calls = 0;
  let finish!: () => void;
  const source = new MTeamSearchSource(
    configs,
    secrets,
    {
      searchMoviePage: async (_base, _key, query) => {
        calls++;
        if ('title' in query && query.title === 'slow')
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        return { releases: [] };
      },
    },
    0
  );
  const signal = new AbortController().signal;
  await assert.rejects(source.search('A', { query: 'slow' }, AbortSignal.abort()));
  assert.equal(calls, 0);
  const first = source.search('A', { query: 'slow' }, signal);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    source.search('A', { query: 'other' }, signal),
    (e) => e instanceof ResourceSiteError && e.reason === 'rateLimited'
  );
  await source.search('B', { query: 'other' }, signal);
  finish();
  await first;
  assert.equal(calls, 2);
});

test('legacy M-Team identity cannot perform searches until it is verified', async () => {
  const source = new MTeamSearchSource({
    find: async (owner) => {
      const row: Awaited<ReturnType<IntegrationConfigStore['find']>> = await configs.find(owner);
      delete row!.externalUserId;
      return row;
    },
  }, secrets, { searchMoviePage: async () => { throw new Error('Unverified identity reached the site'); } }, 0);
  assert.equal(await source.status('A'), 'configured_invalid');
  await assert.rejects(source.search('A', { query: 'Film' }, new AbortController().signal), (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'RESOURCE_SITE_IDENTITY_PENDING';
  });
});
