import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { createModels } from '../models.js';

test('all eight TV collections have isolated names and intended unique/TTL indexes', async () => {
  const connection = mongoose.createConnection();
  const models = createModels(connection);
  try {
    for (const [model, collection, keys] of [
      [models.tvShows, 'tv_shows', ['tmdbId']],
      [models.tvShowLocalizations, 'tv_show_localizations', ['tvShowTmdbId', 'locale']],
      [models.tvSeasons, 'tv_seasons', ['tvShowTmdbId', 'seasonNumber']],
      [models.tvSeasonLocalizations, 'tv_season_localizations', ['tvShowTmdbId', 'seasonNumber', 'locale']],
      [models.tvEpisodes, 'tv_episodes', ['tvShowTmdbId', 'seasonNumber', 'episodeNumber']],
      [models.tvEpisodeLocalizations, 'tv_episode_localizations', ['tvShowTmdbId', 'seasonNumber', 'locale', 'episodeNumber']],
      [models.tvShowResultSets, 'tv_show_result_sets', ['key']],
      [models.tvShowTrendingStates, 'tv_show_trending_states', ['locale', 'timeWindow']],
    ] as const) {
      assert.equal(model.collection.collectionName, collection);
      assert.ok(model.schema.indexes().some(([fields, options]) => options.unique && keys.every((key) => fields[key] === 1)));
      assert.ok(model.schema.paths.createdAt);
      assert.ok(model.schema.paths.updatedAt);
    }
    assert.ok(models.tvShowResultSets.schema.indexes().some(([fields, options]) => fields.deleteAt === 1 && options.expireAfterSeconds === 0));
    assert.equal(new models.tvSeasons({ tmdbId: 1, tvShowTmdbId: 1, seasonNumber: 0 }).episodeCount, undefined);
    assert.ok(new models.tvEpisodes({ tmdbId: 1, tvShowTmdbId: 1, seasonNumber: 0, episodeNumber: 1.2 }).validateSync());
    assert.ok(new models.tvSeasonLocalizations({ tvShowTmdbId: 1, seasonNumber: 0, locale: 'fr-FR', name: 'x' }).validateSync());
  } finally {
    await connection.destroy();
  }
});
