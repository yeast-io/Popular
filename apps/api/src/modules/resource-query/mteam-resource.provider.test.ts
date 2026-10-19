import assert from 'node:assert/strict';
import test from 'node:test';
import { MTeamResourceProvider } from './mteam-resource.provider.js';

test('M-Team adapter projects only public metadata and retains availability, cache and timestamp', async () => {
  const provider = new MTeamResourceProvider({ listReleases: async (ownerId, tmdbId) => {
    assert.equal(ownerId, 'owner');
    assert.equal(tmdbId, 42);
    return {
      provider: 'mteam', availability: 'available', queriedAt: '2026-10-19T00:00:00.000Z', cached: true,
      releases: [{ id: '123', title: 'Film 4K', detailsUrl: 'https://example.com/secret-details', seeders: 3, tags: [] }],
    };
  } });
  assert.deepEqual(await provider.query('owner', 42, new AbortController().signal), {
    provider: 'mteam', status: 'available', queriedAt: '2026-10-19T00:00:00.000Z', cached: true,
    releases: [{ provider: 'mteam', id: '123', title: 'Film 4K', seeders: 3 }],
  }
  );
});

test('cancelled M-Team query never calls the external service', async () => {
  const provider = new MTeamResourceProvider({ listReleases: async () => { throw new Error('must not run'); } });
  await assert.rejects(provider.query('owner', 42, AbortSignal.abort()), /abort/i);
});

test('explicit refresh reaches the M-Team cache bypass option', async () => {
  let force = false;
  const provider = new MTeamResourceProvider({ listReleases: async (_ownerId, _tmdbId, options) => {
    force = options?.force ?? false;
    return { provider: 'mteam', availability: 'unavailable', queriedAt: '2026-10-19T00:00:00.000Z', cached: false, releases: [] };
  } });
  await provider.query('owner', 42, new AbortController().signal, { refresh: true });
  assert.equal(force, true);
});
