import './config/load-env.js';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { closeInfrastructure, connectInfrastructure, createInfrastructure } from './infrastructure/dependencies.js';
import { createLoggers } from './infrastructure/logging/logger.js';
import { createModels } from './infrastructure/mongodb/models.js';
import { MongoAuthUserStore } from './infrastructure/mongodb/user.store.js';
import { RedisSessionStore } from './infrastructure/redis/session.store.js';
import { AuthService } from './modules/auth/auth.service.js';
import { MinioAvatarStore } from './infrastructure/minio/avatar.store.js';
import { UserService } from './modules/users/user.service.js';
import { MongoTrendingStore } from './infrastructure/mongodb/movie.store.js';
import { RedisSyncLock } from './infrastructure/redis/sync-lock.store.js';
import { TmdbClient } from './infrastructure/tmdb/client.js';
import { MovieService } from './modules/movies/movie.service.js';
import { TrendingSyncService } from './modules/movies/trending-sync.service.js';
import { MongoMovieStatusStore } from './infrastructure/mongodb/user-movie-state.store.js';
import { MovieStatusService } from './modules/movie-statuses/movie-status.service.js';
import { MongoIntegrationConfigStore } from './infrastructure/mongodb/integration-config.store.js';
import { MTeamClient } from './infrastructure/mteam/client.js';
import { IntegrationService } from './modules/integrations/integration.service.js';
import { SecretCrypto } from './modules/integrations/secret-crypto.js';
import { MongoMovieResourceCheckStore } from './infrastructure/mongodb/movie-resource-check.store.js';
import { MovieResourceCheckService } from './modules/integrations/movie-resource-check.service.js';

const config = loadConfig();
const loggers = createLoggers(config.LOG_LEVEL);
const infrastructure = createInfrastructure(config);

try {
  await connectInfrastructure(infrastructure);
  const models = createModels(infrastructure.mongodb.getConnection());
  const userStore = new MongoAuthUserStore(models.users, models.authIdentities);
  const sessionStore = new RedisSessionStore(
    infrastructure.redis.getClient(),
    config.SESSION_TOKEN_PEPPER,
    config.SESSION_TTL_SECONDS,
  );
  const authService = new AuthService(userStore, sessionStore);
  const avatarStore = new MinioAvatarStore(infrastructure.minio.getClient(), config.MINIO_BUCKET);
  const userService = new UserService(authService, userStore, avatarStore, config.AVATAR_MAX_BYTES);
  const trendingStore = new MongoTrendingStore(
    models.movies, models.movieLocalizations, models.movieResultSets, models.people, models.movieCredits,
  );
  const tmdb = new TmdbClient(config.TMDB_READ_ACCESS_TOKEN, config.TMDB_REQUEST_TIMEOUT_MS);
  const trendingSync = new TrendingSyncService(
    tmdb, trendingStore, new RedisSyncLock(infrastructure.redis.getClient()),
    config.TMDB_LANGUAGE, config.TRENDING_SYNC_LOCK_TTL_SECONDS,
    {
      info: (bindings, message) => loggers.app.info(bindings, message),
      error: (bindings, message) => loggers.error.error(bindings, message),
    },
  );
  const movieStatusStore = new MongoMovieStatusStore(models.userMovieStates);
  const integrationConfigStore = new MongoIntegrationConfigStore(models.integrationConfigs);
  const mteam = new MTeamClient(config.MTEAM_REQUEST_TIMEOUT_MS);
  const secrets = new SecretCrypto(config.INTEGRATION_SECRET_KEY);
  const movieResourceCheckStore = new MongoMovieResourceCheckStore(
    models.movieResourceChecks,
    models.movieResourceCheckTasks,
  );
  const movieResourceChecks = new MovieResourceCheckService(
    movieResourceCheckStore,
    integrationConfigStore,
    secrets,
    mteam,
    trendingStore,
    tmdb,
    config.TMDB_LANGUAGE,
    {
      resultTtlMs: config.MTEAM_RESOURCE_CHECK_TTL_SECONDS * 1_000,
      retryDelayMs: config.MTEAM_RESOURCE_RETRY_DELAY_SECONDS * 1_000,
      leaseMs: config.MTEAM_RESOURCE_CHECK_LEASE_SECONDS * 1_000,
      minimumIntervalMs: config.MTEAM_SEARCH_MIN_INTERVAL_MS,
    },
    {
      info: (bindings, message) => loggers.app.info(bindings, message),
      error: (bindings, message) => loggers.error.error(bindings, message),
    },
  );
  const movieService = new MovieService(
    trendingStore, trendingSync, tmdb, trendingStore, movieStatusStore,
  );
  const movieStatusService = new MovieStatusService(
    movieStatusStore, trendingStore, config.TMDB_LANGUAGE, movieResourceChecks, movieResourceCheckStore,
  );
  const integrationService = new IntegrationService(
    authService,
    integrationConfigStore,
    mteam,
    secrets,
    new Set(config.MTEAM_ALLOWED_HOSTS),
  );

  const app = await buildApp({
    config, healthDependencies: infrastructure.healthDependencies, authService, userService, movieService, movieStatusService, integrationService,
  });
  app.addHook('onClose', async () => closeInfrastructure(infrastructure));

  const shutdown = async (signal: NodeJS.Signals) => {
    loggers.app.info({ signal }, 'Shutting down');
    await app.close();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.HOST, port: config.PORT });
  loggers.app.info({ host: config.HOST, port: config.PORT }, 'API listening');
} catch (error) {
  loggers.error.fatal({ err: error }, 'API startup failed');
  await closeInfrastructure(infrastructure);
  process.exitCode = 1;
}
