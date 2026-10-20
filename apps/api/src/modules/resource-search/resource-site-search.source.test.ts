import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceSiteSearchSource } from './resource-site-search.source.js';
test('registered site searches retain owner context and stop pagination at the API boundary', async () => {
  const signal = new AbortController().signal;
  const source = new ResourceSiteSearchSource('hdarea', 'HDArea', {
    status: async (owner, site) => {
      assert.equal(owner, 'owner-A');
      assert.equal(site, 'hdarea');
      return 'configured_valid';
    },
    search: async (owner, site, query, receivedSignal) => {
      assert.equal(owner, 'owner-A'); assert.equal(site, 'hdarea'); assert.equal(receivedSignal, signal);
      assert.equal(query.page, 100); return { releases: [{ id: '42', title: 'Film' }], nextPage: 101 };
    },
    detail: async () => ({ id: '42', title: 'Film detail' }),
  });
  assert.equal(await source.status('owner-A'), 'configured_valid');
  const result = await source.search('owner-A', { query: 'Film', page: 100 }, signal);
  assert.equal(result.releases[0]?.id, '42'); assert.equal(result.nextPage, undefined);
});
