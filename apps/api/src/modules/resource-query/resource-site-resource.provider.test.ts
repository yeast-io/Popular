import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceSiteResourceProvider } from './resource-site-resource.provider.js';
import type { ResourceSiteService } from '../resource-sites/resource-site.service.js';

test('assistant provider searches by catalog IMDb identity and projects source identity', async () => {
  let calls = 0;
  const provider = new ResourceSiteResourceProvider(
    'hdarea',
    'HDArea',
    {
      search: async (owner, site, input) => {
        calls++;
        assert.equal(owner, 'owner');
        assert.equal(site, 'hdarea');
        assert.deepEqual(input, { imdbId: 'tt0816692' });
        return { releases: [{ id: '123', title: 'Interstellar' }] };
      },
    } as ResourceSiteService,
    {
      readMovieIdentity: async () => {
        return { title: 'Interstellar', imdbId: 'tt0816692' };
      },
    },
    'zh-CN'
  );
  const result = await provider.query('owner', 42, new AbortController().signal);
  assert.equal(result.status, 'available');
  assert.equal(result.releases[0]!.provider, 'hdarea');
  assert.equal(calls, 1);
  await assert.rejects(provider.query('owner', 42, AbortSignal.abort()));
  assert.equal(calls, 1);
});
test('missing film identity is unmatchable and never triggers an ambiguous keyword lookup', async () => {
  const provider = new ResourceSiteResourceProvider(
    'hdarea',
    'HDArea',
    {
      search: async () => {
        throw new Error('must not run');
      },
    } as unknown as ResourceSiteService,
    { readMovieIdentity: async () => ({ title: 'Film' }) },
    'zh-CN'
  );
  assert.equal((await provider.query('owner', 42, new AbortController().signal)).status, 'unmatchable');
});
