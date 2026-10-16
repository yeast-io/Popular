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
import { MongoOpenAIConfigStore } from './infrastructure/mongodb/openai-config.store.js';
import { OpenAISettingsService } from './modules/integrations/openai-settings.service.js';
import { SecretCrypto } from './modules/integrations/secret-crypto.js';
import { MongoMovieResourceCheckStore } from './infrastructure/mongodb/movie-resource-check.store.js';
import { MovieResourceCheckService } from './modules/integrations/movie-resource-check.service.js';
import { MongoMovieResourceSyncBatchStore } from './infrastructure/mongodb/movie-resource-sync-batch.store.js';
import { MovieResourceSyncService } from './modules/integrations/movie-resource-sync.service.js';
import { MongoQBittorrentConfigStore } from './infrastructure/mongodb/qbittorrent-config.store.js';
import { QBittorrentClient } from './infrastructure/qbittorrent/client.js';
import { QBittorrentIntegrationService } from './modules/integrations/qbittorrent-integration.service.js';
import { MongoMovieDownloadStore } from './infrastructure/mongodb/movie-download.store.js';
import { MovieDownloadService } from './modules/downloads/movie-download.service.js';
import { MongoExternalUsageStore } from './infrastructure/mongodb/external-usage.store.js';
import { ExternalUsageAggregationService } from './modules/external-usage/external-usage-aggregation.service.js';
import { ExternalUsageService } from './modules/external-usage/external-usage.service.js';
import { MongoConversationStore } from './infrastructure/mongodb/conversation.store.js';
import { ConversationService } from './modules/conversations/conversation.service.js';
import OpenAI from 'openai';
import { OpenAILlmClient } from './infrastructure/openai/client.js';
import { Utf8ByteTokenCounter } from './modules/llm/utf8-byte-token-counter.js';
import { ConversationTurnService } from './modules/conversations/conversation-turn.service.js';

const config = loadConfig();
const loggers = createLoggers(config.LOG_LEVEL);
const infrastructure = createInfrastructure(config);

try {
  await connectInfrastructure(infrastructure);
  const models = createModels(infrastructure.mongodb.getConnection());
  await Promise.all([models.externalRequestEvents.init(), models.externalUsageDaily.init()]);
  const externalUsageStore = new MongoExternalUsageStore(
    models.externalRequestEvents,
    models.externalUsageDaily,
    { error: (bindings, message) => loggers.error.error(bindings, message) },
  );
  const externalUsageAggregation = new ExternalUsageAggregationService(
    externalUsageStore,
    { error: (bindings, message) => loggers.error.error(bindings, message) },
  );
  const userStore = new MongoAuthUserStore(models.users, models.authIdentities);
  const sessionStore = new RedisSessionStore(
    infrastructure.redis.getClient(),
    config.SESSION_TOKEN_PEPPER,
    config.SESSION_TTL_SECONDS,
  );
  const authService = new AuthService(userStore, sessionStore, config.REGISTRATION_USER_LIMIT);
  const externalUsageService = new ExternalUsageService(authService, externalUsageStore);
  const avatarStore = new MinioAvatarStore(infrastructure.minio.getClient(), config.MINIO_BUCKET);
  const userService = new UserService(authService, userStore, avatarStore, config.AVATAR_MAX_BYTES, config.AVATAR_MAX_PIXELS);
  const trendingStore = new MongoTrendingStore(
    models.movies, models.movieLocalizations, models.movieResultSets, models.people, models.movieCredits, models.trendingStates,
  );
  const tmdb = new TmdbClient(
    config.TMDB_READ_ACCESS_TOKEN,
    config.TMDB_REQUEST_TIMEOUT_MS,
    undefined,
    undefined,
    externalUsageStore,
  );
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
  const mteam = new MTeamClient(config.MTEAM_REQUEST_TIMEOUT_MS, externalUsageStore);
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
      availableTtlMs: config.MTEAM_RESOURCE_AVAILABLE_TTL_SECONDS * 1_000,
      unavailableTtlMs: config.MTEAM_RESOURCE_UNAVAILABLE_TTL_SECONDS * 1_000,
      retryDelayMs: config.MTEAM_RESOURCE_RETRY_DELAY_SECONDS * 1_000,
      leaseMs: config.MTEAM_RESOURCE_CHECK_LEASE_SECONDS * 1_000,
      minimumIntervalMs: config.MTEAM_SEARCH_MIN_INTERVAL_MS,
      releaseListTtlMs: config.MTEAM_RELEASE_CACHE_TTL_SECONDS * 1_000,
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
  const movieResourceSyncService = new MovieResourceSyncService(
    movieStatusStore,
    movieResourceCheckStore,
    movieResourceChecks,
    new MongoMovieResourceSyncBatchStore(models.movieResourceSyncBatches),
    config.MTEAM_RESOURCE_RETRY_DELAY_SECONDS * 1_000,
    config.MTEAM_RESOURCE_CHECK_LEASE_SECONDS * 1_000,
    {
      info: (bindings, message) => loggers.app.info(bindings, message),
      error: (bindings, message) => loggers.error.error(bindings, message),
    },
  );
  const integrationService = new IntegrationService(
    authService,
    integrationConfigStore,
    mteam,
    secrets,
    new Set(config.MTEAM_ALLOWED_HOSTS),
  );
  const qbittorrentConfigStore = new MongoQBittorrentConfigStore(models.qbittorrentConfigs);
  const qbittorrent = new QBittorrentClient(config.QBITTORRENT_REQUEST_TIMEOUT_MS);
  const qbittorrentIntegrationService = new QBittorrentIntegrationService(
    authService,
    qbittorrentConfigStore,
    qbittorrent,
    secrets,
  );
  const movieDownloadService = new MovieDownloadService(
    authService,
    new MongoMovieDownloadStore(models.movieDownloads),
    qbittorrentConfigStore,
    integrationConfigStore,
    secrets,
    qbittorrent,
    mteam,
    movieResourceChecks,
  );
  const conversationStore = new MongoConversationStore(models.conversationThreads, models.conversationMessages);
  const conversationService = new ConversationService(authService, conversationStore);
  const openaiSettingsService = new OpenAISettingsService(authService, new MongoOpenAIConfigStore(models.openaiConfigs), secrets);
  const conversationTurnService = new ConversationTurnService(
    conversationStore,
    async (ownerId) => new OpenAILlmClient(new OpenAI({
      apiKey: await openaiSettingsService.requireApiKey(ownerId),
      timeout: config.OPENAI_REQUEST_TIMEOUT_MS,
      maxRetries: config.OPENAI_MAX_RETRIES,
    }), config.OPENAI_MODEL),
    new Utf8ByteTokenCounter(),
    {
      systemPrompt: config.OPENAI_SYSTEM_PROMPT,
      maxContextTokens: config.OPENAI_MAX_CONTEXT_TOKENS,
      maxOutputTokens: config.OPENAI_MAX_OUTPUT_TOKENS,
      summaryMaxOutputTokens: config.OPENAI_SUMMARY_MAX_OUTPUT_TOKENS,
      historyLimit: config.OPENAI_HISTORY_LIMIT,
      safetyMarginTokens: 256,
      messageOverheadTokens: 4,
    },
  );

  const app = await buildApp({
    config, healthDependencies: infrastructure.healthDependencies, authService, userService, movieService, movieStatusService, integrationService,
    movieResourceSyncService, qbittorrentIntegrationService, movieDownloadService, externalUsageService, conversationService, openaiSettingsService,
    conversationTurnService,
  });
  await movieResourceSyncService.resumePending();
  externalUsageAggregation.start();
  app.addHook('onClose', async () => {
    externalUsageAggregation.stop();
    await closeInfrastructure(infrastructure);
  });

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
