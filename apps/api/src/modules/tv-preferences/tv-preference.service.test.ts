import assert from 'node:assert/strict';
import test from 'node:test';
import { TvPreferenceService } from './tv-preference.service.js';

test('TV preference listings retain saved order and missing catalog entries with localized fallback', async () => {
  for (const locale of ['en-US', 'zh-CN'] as const) {
    const service = new TvPreferenceService({
      list: async (owner, preference, page, pageSize) => {
        assert.deepEqual([owner, preference, page, pageSize], ['owner', 'disliked', 2, 3]);
        return { ids: [3, 2, 1], total: 7 };
      },
      read: async () => [], set: async () => {}, clear: async () => {},
    }, {
      readSummaries: async (ids, language) => language === locale
        ? [{ mediaType: 'tv', tmdbId: 2, name: 'Local series', genreIds: [], posterPath: '/poster.jpg' }]
        : ids.includes(3) ? [{ mediaType: 'tv', tmdbId: 3, name: 'Fallback series', genreIds: [] }] : [],
    });
    const result = await service.list('owner', 'disliked', 2, 3, locale);
    assert.deepEqual(result.items.map((item) => item.tmdbId), [3, 2, 1]);
    assert.equal(result.items[0]?.title, 'Fallback series');
    assert.equal(result.items[1]?.posterUrl, 'https://image.tmdb.org/t/p/w500/poster.jpg');
    assert.match(result.items[2]!.title, locale === 'zh-CN' ? /资料暂不可用/ : /Information unavailable/);
    assert.deepEqual(result.pagination, { page: 2, pageSize: 3, total: 7, hasMore: true });
    assert.equal(result.locale, locale);
  }
});
