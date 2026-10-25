import assert from 'node:assert/strict';
import test from 'node:test';
import type { IntegrationPreferences, MovieSiteReleaseList, ResourceSiteRelease } from '@movie-hub/contract';
import type { MovieResourceCheckRecord, MovieResourceCheckStore } from './movie-resource-check.types.js';
import { MovieSiteResourcesService } from './movie-site-resources.service.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import { MovieReleaseCacheService } from './movie-release-cache.service.js';
import type { MovieReleaseCacheEntry } from './movie-release-cache.types.js';
import { MovieReleaseCacheError } from './movie-release-cache.errors.js';

function harness() {
  const cacheRows = new Map<string, MovieReleaseCacheEntry>();
  const revisions = new Map<string, string>();
  let cacheFailure = false;
  const releaseCache = new MovieReleaseCacheService({
    async read(key) {
      if (cacheFailure) throw new Error('Redis unavailable');
      const entry = cacheRows.get(key);
      return entry && Date.parse(entry.expiresAt) > Date.now() ? entry : null;
    },
    async write(key, value, ttlMs) {
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      cacheRows.set(key, { value, expiresAt });
      return expiresAt;
    },
    async readRevision(scopeKey) { return revisions.get(scopeKey) ?? null; },
    async activateRevision(scopeKey, revision) {
      revisions.set(scopeKey, revision);
    },
  }, 60_000);
  const rows = new Map<string, MovieResourceCheckRecord>();
  const calls: Array<{ owner: string; page: number }> = [];
  const mteamCalls: string[] = [];
  const selections = new Map<string, string[]>();
  let version = 'v1';
  let fail = false;
  let nextPage: number | undefined;
  let gate = Promise.resolve();
  const pageResults = new Map<number, { releases: ResourceSiteRelease[]; nextPage?: number }>();
  let releases: ResourceSiteRelease[] = [{ id: '42', title: 'Film', imdbId: 'tt0000603', seeders: 2 }];
  const key = (owner: string, tmdbId: number, site: string) => `${owner}:${tmdbId}:${site}`;
  const checks: MovieResourceCheckStore = {
    async readForMovies(owner, ids) {
      return [...rows.values()].filter((row) => {
        return row.ownerId === owner && ids.includes(row.tmdbId);
      });
    },
    async readOne(input) {
      return rows.get(key(input.ownerId, input.tmdbId, input.provider)) ?? null;
    },
    async tryAcquire(input) {
      const id = key(input.ownerId, input.tmdbId, input.provider);
      const old = rows.get(id);
      if (old?.checking) return false;
      rows.set(id, { ...input, availability: old?.availability ?? 'unchecked', ...old, checking: true });
      return true;
    },
    async complete(input, _at, result) {
      const id = key(input.ownerId, input.tmdbId, input.provider);
      rows.set(id, { ...input, availability: 'unchecked', ...rows.get(id), ...result, checking: false });
    },
    async recordAttempt(input, _at, result) {
      const id = key(input.ownerId, input.tmdbId, input.provider);
      rows.set(id, {
        ...input,
        availability: 'unchecked',
        ...rows.get(id),
        ...result,
        checking: rows.get(id)?.checking ?? false,
      });
    },
  };
  const preferences = {
    async get(owner: string): Promise<IntegrationPreferences> {
      return {
        defaults: { resource: 'mteam' },
        selectedSites: selections.get(owner) ?? [],
        effectiveSites: selections.get(owner) ?? ['mteam', 'hdarea'],
        choices: [],
      };
    },
  };
  const service = new MovieSiteResourcesService(
    checks,
    {
      async request() {
        throw new ResourceSiteError('notConfigured');
      },
      async checkNowDetailed(owner, tmdbId) {
        mteamCalls.push(owner);
        const result = {
          lastAttemptStatus: 'success' as const,
          availability: 'unavailable' as const,
          checkedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          matchedBy: 'imdb' as const,
        };
        await checks.recordAttempt({ ownerId: owner, tmdbId, provider: 'mteam' }, new Date(), result);
        return { started: true, result };
      },
      async listReleases() {
        return {
          provider: 'mteam',
          availability: 'available',
          queriedAt: new Date().toISOString(),
          cached: false,
          releases: [
            { id: '42', title: 'M-Team Film', detailsUrl: 'https://kp.m-team.cc/detail/42', seeders: 10, tags: [] },
          ],
        };
      },
    },
    preferences,
    {
      async search(owner, _site, input) {
        calls.push({ owner, page: input.page ?? 1 });
        await gate;
        if (fail) throw new ResourceSiteError('timeout');
        if (pageResults.has(input.page ?? 1)) return pageResults.get(input.page ?? 1)!;
        return { releases, ...(nextPage ? { nextPage } : {}) };
      },
    },
    {
      registry: new Map([
        [
          'hdarea',
          {
            id: 'hdarea',
            name: 'HDArea',
            baseUrl: 'https://hdarea.example/',
            async verify() { return '101'; },
            async search() {
              return { releases: [] };
            },
            async detail(id) {
              return { id: String(id), title: '' };
            },
            detailsUrl(id: string) {
              return `https://hdarea.example/details.php?id=${id}`;
            },
          },
        ],
      ]),
      async configuration(_owner, site) {
        return { site, status: 'configured_valid', verifiedAt: '2026-10-20T00:00:00Z' };
      },
      async cacheVersion() {
        return version;
      },
    },
    {
      async hasMovie() {
        return true;
      },
      async readMovieIdentity() {
        return { title: 'Film', imdbId: 'tt0000603' };
      },
      async writeMovieDetail() {},
    },
    {
      async fetchDetails() {
        throw new Error('Unexpected movie refresh');
      },
    },
    'en-US',
    { logger: { error() {} }, verbose: false },
    releaseCache,
    60_000
  );
  return {
    service,
    checks,
    calls,
    mteamCalls,
    selections,
    pageResults,
    block() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    setVersion: (value: string) => {
      version = value;
    },
    setFailure: (value: boolean) => {
      fail = value;
    },
    setCacheFailure: (value: boolean) => {
      cacheFailure = value;
    },
    setResults: (value: ResourceSiteRelease[], next?: number) => {
      releases = value;
      nextPage = next;
    },
  };
}
test('a Redis read failure does not mark the resource site as failed', async () => {
  const f = harness();
  f.setCacheFailure(true);
  await assert.rejects(f.service.listReleases('alice', 603, 'hdarea'), MovieReleaseCacheError);
  assert.equal(await f.checks.readOne({ ownerId: 'alice', tmdbId: 603, provider: 'hdarea' }), null);
  await f.service.stop();
});
test('release snapshots are separated by owner, site and credential version; source capability stays explicit', async () => {
  const f = harness();
  const first = await f.service.listReleases('alice', 603, 'hdarea');
  assert.equal(first.supportsDownload, false);
  assert.equal(first.releases[0]?.detailsUrl, 'https://hdarea.example/details.php?id=42');
  assert.equal((await f.service.listReleases('alice', 603, 'hdarea')).cached, true);
  await f.service.listReleases('bob', 603, 'hdarea');
  f.setVersion('v2');
  await f.service.listReleases('alice', 603, 'hdarea');
  assert.deepEqual(
    f.calls.map((call) => call.owner),
    ['alice', 'bob', 'alice']
  );
  const mteam = await f.service.listReleases('alice', 603, 'mteam');
  assert.equal(mteam.releases[0]?.id, first.releases[0]?.id);
  assert.equal(mteam.supportsDownload, true);
  assert.notEqual(mteam.releases[0]?.title, first.releases[0]?.title);
  await f.service.stop();
});
test('a failed source preserves prior results and cannot turn an incomplete multi-source check into no resources', async () => {
  const f = harness();
  await f.service.checkNowDetailed('alice', 603, true, ['mteam', 'hdarea']);
  assert.equal((await f.service.summary('alice', 603)).availability, 'available');
  f.setFailure(true);
  await f.service.checkNowDetailed('alice', 603, true, ['mteam', 'hdarea']);
  const summary = await f.service.summary('alice', 603);
  assert.equal(summary.availability, 'unchecked');
  assert.equal(summary.incomplete, true);
  assert.equal(summary.sources?.find((source) => source.provider === 'hdarea')?.availability, 'available');
  assert.equal(summary.sources?.find((source) => source.provider === 'hdarea')?.lastAttemptStatus, 'error');
  await f.service.stop();
});
test('fixed batch sites ignore later account selection and enqueue failure does not stop other sites', async () => {
  const f = harness();
  f.selections.set('alice', ['mteam', 'hdarea']);
  await f.service.request('alice', 603);
  await f.service.stop();
  assert.equal(f.calls.length, 1);
  const next = harness();
  next.selections.set('alice', ['mteam']);
  await next.service.checkNowDetailed('alice', 603, true, ['hdarea']);
  assert.equal(next.mteamCalls.length, 0);
  assert.equal(next.calls.length, 1);
  await next.service.stop();
});
test('unknown seeder counts remain visible and invalid pagination cannot loop forever', async () => {
  const f = harness();
  f.setResults([{ id: '42', title: 'Unknown seed count' }]);
  const unknown: MovieSiteReleaseList = await f.service.listReleases('alice', 603, 'hdarea');
  assert.equal(unknown.availability, 'available');
  assert.equal(unknown.releases[0]?.seedersKnown, false);
  f.setResults([], 1);
  await assert.rejects(f.service.listReleases('bob', 603, 'hdarea'), ResourceSiteError);
  assert.equal(f.calls.filter((call) => call.owner === 'bob').length, 1);
  await f.service.stop();
});

test('background checks queue per site and duplicate queued checks do not fan out upstream', async () => {
  const f = harness();
  f.selections.set('alice', ['hdarea']);
  const release = f.block();
  await f.service.request('alice', 1);
  await f.service.request('alice', 2);
  await f.service.request('alice', 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.summary('alice', 2)).checking, true);
  release();
  await f.service.stop();
  assert.equal(f.calls.length, 2);
});

test('an inactive first page is followed and an empty later page cannot overwrite positive movie availability', async () => {
  const f = harness();
  f.pageResults.set(1, { releases: [{ id: '1', title: 'No seeders', seeders: 0 }], nextPage: 2 });
  f.pageResults.set(2, { releases: [{ id: '2', title: 'Active', seeders: 1 }], nextPage: 3 });
  f.pageResults.set(3, { releases: [] });
  const result = await f.service.listReleases('alice', 603, 'hdarea');
  assert.equal(result.availability, 'available');
  assert.equal(result.releases[0]?.id, '2');
  await f.service.listReleases('alice', 603, 'hdarea', 3);
  assert.equal((await f.service.summary('alice', 603, ['hdarea'])).availability, 'available');
  assert.deepEqual(
    f.calls.map((call) => call.page),
    [1, 2, 3]
  );
  await f.service.stop();
});

test('a forced site refresh bypasses its cached snapshot and preserves other owners', async () => {
  const f = harness();
  try {
    await f.service.listReleases('alice', 603, 'hdarea');
    await f.service.listReleases('bob', 603, 'hdarea');
    f.setResults([{ id: '99', title: 'Updated Film', imdbId: 'tt0000603', seeders: 5 }]);
    const fresh = await f.service.listReleases('alice', 603, 'hdarea', 1, true);
    assert.equal(fresh.cached, false);
    assert.equal(fresh.releases[0]?.id, '99');
    assert.equal((await f.service.listReleases('alice', 603, 'hdarea')).releases[0]?.id, '99');
    assert.equal((await f.service.listReleases('bob', 603, 'hdarea')).releases[0]?.id, '42');
    assert.deepEqual(
      f.calls.map((call) => call.owner),
      ['alice', 'bob', 'alice']
    );
    assert.equal(f.mteamCalls.length, 0);
  } finally {
    await f.service.stop();
  }
});

test('preserves HDArea metadata through projection and cached responses', async () => {
  const f = harness();
  const release = {
    id: '42',
    title: 'Movie 1080p H264-GROUP',
    seeders: 2,
    publishedAt: '2026-10-05 23:05:14',
    medium: 'WEB-DL',
    videoCodec: 'H.264',
    audioCodec: 'E-AC-3 5.1',
    releaseGroup: 'GROUP',
    tags: ['4K', 'DoVi', 'chinese-subtitles'],
  };
  f.setResults([release]);
  for (const cached of [false, true]) {
    const result = await f.service.listReleases('alice', 603, 'hdarea');
    assert.equal(result.cached, cached);
    assert.deepEqual(result.releases[0], {
      ...release,
      seedersKnown: true,
      detailsUrl: 'https://hdarea.example/details.php?id=42',
    }
    );
  }
  await f.service.stop();
});

test('download validation accepts a release on a later source page and rejects unrelated IDs', async () => {
  const f = harness();
  f.pageResults.set(1, { releases: [{ id: '42', title: 'First', seeders: 2 }], nextPage: 2 });
  f.pageResults.set(2, { releases: [{ id: '99', title: 'Selected', seeders: 3 }] });
  assert.equal((await f.service.releaseForDownload('alice', 603, 'hdarea', '99')).id, '99');
  await assert.rejects(f.service.releaseForDownload('alice', 603, 'hdarea', '999'));
  await f.service.stop();
});
