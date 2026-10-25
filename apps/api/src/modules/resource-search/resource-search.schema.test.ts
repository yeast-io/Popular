import assert from 'node:assert/strict';
import test from 'node:test';
import { isResourceSearchCacheValue } from './resource-search.schema.js';

const result = {
  cached: false,
  queriedAt: '2026-10-25T00:00:00.000Z',
  releases: [{ id: '991', title: 'Show S01', detailsUrl: 'https://source.example/detail/991',
    description: 'Season pack', sizeBytes: 1024, seeders: 10, resolution: '4K', releaseGroup: 'Group', tags: ['DoVi'] }],
};

test('cached resources with valid detail URLs pass runtime validation', () => {
  assert.equal(isResourceSearchCacheValue(JSON.parse(JSON.stringify(result))), true);
});

test('malformed detail URLs and timestamps still invalidate cached results', () => {
  assert.equal(isResourceSearchCacheValue({ ...result, releases: [{ ...result.releases[0], detailsUrl: 'not a URL' }] }), false);
  assert.equal(isResourceSearchCacheValue({ ...result, queriedAt: 'invalid' }), false);
});
