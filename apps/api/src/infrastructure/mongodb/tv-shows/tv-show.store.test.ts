import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createModels } from '../models.js';
import { MongoTvShowStore } from './tv-show.store.js';
import { MongoTvSeasonStore } from './tv-season.store.js';
import type { TvSeasonRecord } from '../../../modules/tv-shows/tv-season.types.js';
import type { TvShowRecord } from '../../../modules/tv-shows/tv-show.types.js';

// Explicitly opt in; always use a new disposable database, never the URI's database.
test('real Mongo TV stores preserve detail, locale isolation, incomplete-season protection', {
  skip: !process.env.POPULAR_TV_MONGO_TEST_URI,
}, async () => {
  const database = `popular_tv_test_${randomUUID().replaceAll('-', '')}`;
  const connection = await mongoose.createConnection(process.env.POPULAR_TV_MONGO_TEST_URI!, { dbName: database, serverSelectionTimeoutMS: 5000 }).asPromise();
  try {
    const models = createModels(connection);
    await Promise.all([models.tvShows, models.tvShowLocalizations, models.tvSeasons, models.tvSeasonLocalizations,
      models.tvEpisodes, models.tvEpisodeLocalizations].map((model) => model.init()));
    const seasons = new MongoTvSeasonStore(models);
    const catalog = new MongoTvShowStore(models, seasons);
    const now = new Date();
    const season: TvSeasonRecord = { tmdbId: 90, tvShowTmdbId: 42, seasonNumber: 1, name: 'Season 1', episodeCount: 1,
      episodes: [{ tmdbId: 100, tvShowTmdbId: 42, seasonNumber: 1, episodeNumber: 1, name: 'Pilot', overview: 'Story', stillPath: '/a.jpg' }] };
    const show: TvShowRecord = { mediaType: 'tv', tmdbId: 42, name: 'English show', tagline: 'English tagline', overview: 'Overview', genreIds: [18], numberOfSeasons: 1, seasons: [season] };
    await catalog.writeDetail(show, 'en-US', now);
    await seasons.writeDetail(season, 'en-US', now);
    await catalog.upsertSummaries([{ mediaType: 'tv', tmdbId: 42, name: 'Updated name', genreIds: [18] }], 'en-US', new Date(now.getTime() + 1));
    assert.equal((await catalog.readDetail(42, 'en-US'))?.numberOfSeasons, 1);
    assert.equal((await catalog.readDetail(42, 'en-US'))?.seasons?.length, 1);
    assert.equal((await seasons.readDetail(42, 1, 'en-US'))?.episodes?.[0]?.overview, 'Story');
    assert.equal(await catalog.readDetail(42, 'zh-CN'), null);
    await catalog.writeDetail({ ...show, name: '中文剧名', tagline: '中文宣传语' }, 'zh-CN', new Date(now.getTime() + 2));
    assert.equal((await catalog.readDetail(42, 'en-US'))?.name, 'Updated name');
    assert.equal((await catalog.readDetail(42, 'zh-CN'))?.name, '中文剧名');
    assert.equal((await catalog.readDetail(42, 'en-US'))?.tagline, 'English tagline');
    assert.equal((await catalog.readDetail(42, 'zh-CN'))?.tagline, '中文宣传语');
    assert.ok((await catalog.readDetail(42, 'en-US'))?.taglineSyncedAt);
    const { tagline: _tagline, ...withoutTagline } = show;
    await catalog.writeDetail(withoutTagline, 'en-US', now);
    assert.equal((await catalog.readDetail(42, 'en-US'))?.tagline, undefined);
    assert.ok((await catalog.readDetail(42, 'en-US'))?.taglineSyncedAt);
    // Force a failed intermediate write: no completeness marker may survive.
    await models.tvSeasonLocalizations.updateOne({ tvShowTmdbId: 42, seasonNumber: 1, locale: 'en-US' }, { $unset: { episodeListSyncedAt: 1 } });
    assert.equal(await seasons.readDetail(42, 1, 'en-US'), null);
    // A successful full refresh clears now-missing localized fields.
    await seasons.writeDetail({ ...season, episodes: [{ tmdbId: 100, tvShowTmdbId: 42, seasonNumber: 1, episodeNumber: 1, name: 'Pilot' }] }, 'en-US', new Date(now.getTime() + 3));
    assert.equal((await seasons.readDetail(42, 1, 'en-US'))?.episodes?.[0]?.overview, undefined);
    assert.equal((await seasons.readDetail(42, 1, 'en-US'))?.episodes?.[0]?.stillPath, undefined);
    await seasons.writeDetail({ ...season, episodeCount: 0, episodes: [] }, 'en-US', new Date(now.getTime() + 4));
    assert.deepEqual((await seasons.readDetail(42, 1, 'en-US'))?.episodes, []);
    const trailer = { tmdbVideoId: 'video', provider: 'youtube' as const, providerVideoId: 'Safe_video-1', name: 'Trailer', official: true, publishedAt: '2026-01-01T00:00:00.000Z' };
    await catalog.writeDetail({ ...show, trailer }, 'en-US', new Date());
    assert.deepEqual((await catalog.readDetail(42, 'en-US'))?.trailer, trailer);
    assert.ok((await catalog.readDetail(42, 'en-US'))?.trailerSyncedAt);
    await catalog.upsertSummaries([show], 'en-US', new Date());
    assert.deepEqual((await catalog.readDetail(42, 'en-US'))?.trailer, trailer);
    await catalog.writeDetail(show, 'en-US', new Date());
    assert.equal((await catalog.readDetail(42, 'en-US'))?.trailer, undefined);
    assert.ok((await catalog.readDetail(42, 'en-US'))?.trailerSyncedAt);
  } finally {
    // This database was created by this test and its randomized name cannot target application data.
    await connection.dropDatabase();
    await connection.close();
  }
});
