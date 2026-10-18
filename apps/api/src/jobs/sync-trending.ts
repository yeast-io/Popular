import '../config/load-env.js';
import { loadTrendingConfig } from '../config/env.js';
import { createLoggers } from '../infrastructure/logging/logger.js';
import { MongoTrendingStore } from '../infrastructure/mongodb/movies/movie.store.js';
import { createModels } from '../infrastructure/mongodb/models.js';
import { MongoDbConnector } from '../infrastructure/mongodb/connector.js';
import { RedisConnector } from '../infrastructure/redis/connector.js';
import { RedisSyncLock } from '../infrastructure/redis/sync-lock.store.js';
import { TmdbClient } from '../infrastructure/tmdb/client.js';
import { TrendingSyncService } from '../modules/movies/trending-sync.service.js';

const scheduledLocale = 'zh-CN';

const config = loadTrendingConfig();
const loggers = createLoggers(config.LOG_LEVEL);
const mongodb = new MongoDbConnector(config.MONGODB_URI, config.MONGODB_DB_NAME);
const redis = new RedisConnector(config.REDIS_URL, config.REDIS_KEY_PREFIX);
let syncInvoked = false;

try {
  await Promise.all([mongodb.connect(), redis.connect()]);
  const models = createModels(mongodb.getConnection());
  const store = new MongoTrendingStore(
    models.movies, models.movieLocalizations, models.movieResultSets, models.people, models.movieCredits, models.trendingStates,
  );
  const service = new TrendingSyncService(
    new TmdbClient(config.TMDB_READ_ACCESS_TOKEN, config.TMDB_REQUEST_TIMEOUT_MS),
    store,
    new RedisSyncLock(redis.getClient(), config.REDIS_LOCK_TRACE_ENABLED, loggers.app),
    scheduledLocale,
    config.TRENDING_SYNC_LOCK_TTL_SECONDS,
    {
      info: (bindings, message) => loggers.app.info(bindings, message),
      error: (bindings, message) => loggers.error.error(bindings, message),
    },
  );
  syncInvoked = true;
  await service.syncConfiguredPages(config.TRENDING_SYNC_PAGES, config.TRENDING_SYNC_CONCURRENCY, 'manual');
} catch (error) {
  if (!syncInvoked) loggers.error.error({ err: error, operation: 'sync.trending.bootstrap' }, 'Trending sync could not start');
  process.exitCode = 1;
} finally {
  await Promise.allSettled([mongodb.close(), redis.close()]);
}
