import { MongoRemoteCommandIndexMigration } from './infrastructure/mongodb/remote-downloads/remote-command-index-migration.store.js';
import { MongoSiteAccountMigrationStore } from './infrastructure/mongodb/resource-sites/site-account-migration.store.js';
import { SiteAccountMigrationService } from './modules/resource-sites/site-account-migration.service.js';
import { randomUUID } from 'node:crypto';
import { GatewayPool } from './infrastructure/socket/gateway-pool.service.js';
import { MongoRemoteControlStore } from './infrastructure/mongodb/remote-downloads/remote-control.store.js';
import { RemoteDownloadService } from './modules/remote-downloads/remote-download.service.js';
import { RemoteMovieDownloadService } from './modules/remote-downloads/remote-movie-download.service.js';
import { RemoteDownloadCoordinator } from './modules/remote-downloads/remote-download-coordinator.service.js';
import { RemoteDownloadWorker } from './modules/remote-downloads/remote-download.worker.js';
import { readTorrentMetadata } from './modules/remote-downloads/torrent-metadata.schema.js';
import { integrationSecretContext } from './modules/integrations/integration.service.js';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { AiTrace, withAiTrace, currentAiTrace } from './infrastructure/logging/ai-trace.js';
import { MongoRemoteAuthorizationMigration } from './infrastructure/mongodb/remote-clients/remote-authorization-migration.store.js';
import { MongoRemoteAuthorizationStore } from './infrastructure/mongodb/remote-clients/remote-authorization.store.js';
import { RemoteClientService } from './modules/remote-clients/remote-client.service.js';
import { AuthorizationGatewayClient } from './modules/remote-clients/authorization-gateway.service.js';
import { RemoteClientWorker } from './modules/remote-clients/remote-client.worker.js';
import { withMTeamEndpoints } from './modules/integrations/mteam-endpoints.domain.js';
import { IntegrationPreferencesService } from './modules/integrations/integration-preferences.service.js';
import { MongoIntegrationPreferencesStore } from './infrastructure/mongodb/integrations/integration-preferences.store.js';
import { MovieSiteResourcesService } from './modules/integrations/movie-site-resources.service.js';
import { createAssistantSessionModel } from './infrastructure/mongodb/assistant/assistant-session.schema.js';
import { MongoAssistantSessionStore } from './infrastructure/mongodb/assistant/assistant-session.store.js';
import { initializeAssistantRetention } from './infrastructure/mongodb/assistant-retention.js';
import { ResourceQueryTool } from './modules/resource-query/resource-query.tool.js';
import { ResourceSearchService } from './modules/resource-search/resource-search.service.js';
import { MTeamSearchSource } from './modules/resource-search/mteam-search.source.js';
import { ResourceSiteSearchSource } from './modules/resource-search/resource-site-search.source.js';
import { ResourceSiteService } from './modules/resource-sites/resource-site.service.js';
import { HDAreaAdapter } from './infrastructure/hdarea/hdarea.adapter.js';
import { HDAreaHttpClient } from './infrastructure/hdarea/hdarea-http.client.js';
import { MongoResourceSiteCredentialStore } from './infrastructure/mongodb/resource-sites/resource-site-credential.store.js';
import { ResourceSiteResourceProvider } from './modules/resource-query/resource-site-resource.provider.js';
import { MTeamResourceProvider } from './modules/resource-query/mteam-resource.provider.js';
import { createResourceQueryModel } from './infrastructure/mongodb/resource-query/resource-query.schema.js';
import { MongoResourceQueryStore } from './infrastructure/mongodb/resource-query/resource-query.store.js';
import { createAssistantConversationReply } from './modules/assistant/assistant.conversation.js';
import { ApplicationShutdown, installShutdownHandlers } from './infrastructure/lifecycle/shutdown.js';
import { TelegramService } from './modules/telegram/telegram.service.js';
import { AssistantWorkflow } from './modules/assistant/assistant.workflow.js';
import { AssistantMessageReceiver } from './modules/assistant/assistant.receiver.js';
import { AssistantWorker } from './modules/assistant/assistant.worker.js';
import { MongoAssistantQueue } from './infrastructure/mongodb/assistant/assistant-message.store.js';
import { TelegramWorker } from './modules/telegram/telegram.worker.js';
import { TelegramClient } from './infrastructure/telegram/client.js';
import { MongoTelegramStore } from './infrastructure/mongodb/telegram/telegram.store.js';
import { probeOpenAI } from './infrastructure/openai/connection-probe.js';
import { NotificationTestService } from './modules/notifications/notification-test.service.js';
import { MongoNotificationTestStore } from './infrastructure/mongodb/notifications/notification-test.store.js';
import './config/load-env.js';
import { MongoNotificationStore } from './infrastructure/mongodb/notifications/notification.store.js';
import { NotificationService } from './modules/notifications/notification.service.js';
import { NotificationWorker } from './modules/notifications/notification.worker.js';
import { WhatsAppService } from './modules/whatsapp/whatsapp.service.js';
import { MongoWhatsAppStore } from './infrastructure/mongodb/whatsapp/whatsapp.store.js';
import { connectBaileys } from './infrastructure/whatsapp/baileys.connector.js';
import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';
import { connectInfrastructure, createInfrastructure } from './infrastructure/dependencies.js';
import { createLoggers } from './infrastructure/logging/logger.js';
import { createModels } from './infrastructure/mongodb/models.js';
import { MongoAuthUserStore } from './infrastructure/mongodb/users/user.store.js';
import { RedisSessionStore } from './infrastructure/redis/session.store.js';
import { AuthService } from './modules/auth/auth.service.js';
import { MinioAvatarStore } from './infrastructure/minio/avatar.store.js';
import { UserService } from './modules/users/user.service.js';
import { MongoTrendingStore } from './infrastructure/mongodb/movies/movie.store.js';
import { RedisSyncLock } from './infrastructure/redis/sync-lock.store.js';
import { TmdbClient } from './infrastructure/tmdb/client.js';
import { MovieService } from './modules/movies/movie.service.js';
import { TrendingSyncService } from './modules/movies/trending-sync.service.js';
import { MongoMovieStatusStore } from './infrastructure/mongodb/movie-statuses/user-movie-state.store.js';
import { MovieStatusService } from './modules/movie-statuses/movie-status.service.js';
import { MongoIntegrationConfigStore } from './infrastructure/mongodb/integrations/integration-config.store.js';
import { MTeamClient } from './infrastructure/mteam/client.js';
import { IntegrationService } from './modules/integrations/integration.service.js';
import { MongoOpenAIConfigStore } from './infrastructure/mongodb/integrations/openai-config.store.js';
import { OpenAISettingsService } from './modules/integrations/openai-settings.service.js';
import { SecretCrypto } from './modules/integrations/secret-crypto.js';
import { MongoMovieResourceCheckStore } from './infrastructure/mongodb/movie-resources/movie-resource-check.store.js';
import { MovieResourceCheckService } from './modules/integrations/movie-resource-check.service.js';
import { MongoMovieResourceSyncBatchStore } from './infrastructure/mongodb/movie-resources/movie-resource-sync-batch.store.js';
import { MovieResourceSyncService } from './modules/integrations/movie-resource-sync.service.js';
import { MongoQBittorrentConfigStore } from './infrastructure/mongodb/integrations/qbittorrent-config.store.js';
import { MongoTransmissionConfigStore } from './infrastructure/mongodb/integrations/transmission-config.store.js';
import { MongoDownloaderInstanceMigration } from './infrastructure/mongodb/integrations/downloader-instance-migration.store.js';
import { TransmissionClient } from './infrastructure/transmission/client.js';
import { TransmissionIntegrationService } from './modules/integrations/transmission-integration.service.js';
import { QBittorrentClient } from './infrastructure/qbittorrent/client.js';
import { QBittorrentIntegrationService } from './modules/integrations/qbittorrent-integration.service.js';
import { MongoMovieDownloadStore } from './infrastructure/mongodb/downloads/movie-download.store.js';
import { MovieDownloadService } from './modules/downloads/movie-download.service.js';
import { MongoExternalUsageStore } from './infrastructure/mongodb/external-usage/external-usage.store.js';
import { ExternalUsageAggregationService } from './modules/external-usage/external-usage-aggregation.service.js';
import { ExternalUsageService } from './modules/external-usage/external-usage.service.js';
import { MongoConversationStore } from './infrastructure/mongodb/conversations/conversation.store.js';
import { ConversationService } from './modules/conversations/conversation.service.js';
import OpenAI from 'openai';
import { OpenAILlmClient } from './infrastructure/openai/client.js';
import { Utf8ByteTokenCounter } from './modules/llm/utf8-byte-token-counter.js';
import { ConversationTurnService } from './modules/conversations/conversation-turn.service.js';
import { MongoPreferenceStore } from './infrastructure/mongodb/preferences/preference.store.js';
import { createPreferenceModels } from './infrastructure/mongodb/preferences/preference.schema.js';
import { MongoRecommendationStore } from './infrastructure/mongodb/recommendations/recommendation.store.js';
import { createRecommendationModel } from './infrastructure/mongodb/recommendations/recommendation.schema.js';
import { PreferenceService } from './modules/preferences/preference.service.js';
import { PreferenceAgent } from './modules/preferences/agents/preference.agent.js';
import { PreferenceWorkflow } from './modules/preferences/preference.workflow.js';
import { PreferenceWorker } from './modules/preferences/preference.worker.js';
import { RecommendationTool } from './modules/recommendations/recommendation.tool.js';

const config = loadConfig();
const loggers = createLoggers(config.LOG_LEVEL);
const infrastructure = createInfrastructure(config);
let finishStartup!: () => void;
const startupSettled = new Promise<void>((resolve) => {
  finishStartup = resolve;
});
const shutdown = new ApplicationShutdown(loggers.app, startupSettled, config.SHUTDOWN_TIMEOUT_MS);
shutdown.register('minio', 90, () => infrastructure.minio.close());
shutdown.register('mongodb', 100, () => infrastructure.mongodb.close());
shutdown.register('redis', 110, () => infrastructure.redis.close());
const shutdownHandlers = installShutdownHandlers(shutdown, process, async () => {
  await Promise.all(
    [loggers.app, loggers.error].map((logger) => new Promise<void>((resolve) => logger.flush(() => resolve())))
  );
});

try {
  await connectInfrastructure(infrastructure);
  shutdown.assertRunning();
  const models = createModels(infrastructure.mongodb.getConnection());
  const commandIndexMigrationTrace = new AiTrace(loggers.error, {}, '', 'remote-command-index.migration', config.VERBOSE);
  await withAiTrace(commandIndexMigrationTrace, async () => {
    try {
      await commandIndexMigrationTrace.step('remote-command-index.migration', () =>
        new MongoRemoteCommandIndexMigration(models.remoteControl.commands, models.movieDownloads).migrate());
    } catch (error) {
      commandIndexMigrationTrace.fail(error);
      throw error;
    }
  });
  const downloaderMigration = new MongoDownloaderInstanceMigration(
    models.qbittorrentConfigs,
    models.transmissionConfigs,
    models.movieDownloads,
    models.integrationPreferences
  );
  const downloaderMigrationTrace = new AiTrace(loggers.error, {}, '', 'downloader-instance.migration', config.VERBOSE);
  await withAiTrace(downloaderMigrationTrace, async () => {
    try {
      await downloaderMigrationTrace.step('downloader-instance.migration', () => downloaderMigration.migrate());
    } catch (error) {
      downloaderMigrationTrace.fail(error);
      throw error;
    }
  });
  await Promise.all([models.externalRequestEvents.init(), models.externalUsageDaily.init()]);
  const externalUsageStore = new MongoExternalUsageStore(models.externalRequestEvents, models.externalUsageDaily, {
    error: (bindings, message) => loggers.error.error(bindings, message),
  });
  const externalUsageAggregation = new ExternalUsageAggregationService(
    externalUsageStore,
    {
      info: (bindings, message) => loggers.app.info(bindings, message),
      error: (bindings, message) => loggers.error.error(bindings, message),
    },
    undefined,
    undefined,
    config.SCAN_TRACE_ENABLED
  );
  shutdown.register('external_usage_aggregation', 45, () => externalUsageAggregation.stop());
  await Promise.all([models.users.init(), models.remoteDevices.init(), models.remoteAuthorizations.init()]);
  const remoteMigration = new MongoRemoteAuthorizationMigration(
    models.users,
    models.remoteDevices,
    models.remoteAuthorizations
  );
  const migrationTrace = new AiTrace(loggers.error, {}, '', 'remote-client.migration', config.VERBOSE);
  await withAiTrace(migrationTrace, async () => {
    try {
      await migrationTrace.step('remote-client.migration', () => remoteMigration.migrate());
    } catch (error) {
      migrationTrace.fail(error);
      throw error;
    }
  });
  const gatewayPool = new GatewayPool({
    urls: config.REMOTE_GATEWAY_BASE_URL ? [config.REMOTE_GATEWAY_BASE_URL] : [],
    token: config.REMOTE_GATEWAY_SERVICE_TOKEN ?? '',
    instanceId: randomUUID(),
    size: config.REMOTE_GATEWAY_POOL_SIZE,
    allowInsecure: config.REMOTE_GATEWAY_ALLOW_INSECURE_DEV,
    diagnostics: {
      verbose: config.VERBOSE,
      info: (fields) => loggers.app.info(fields, 'gateway-pool'),
      error: (err, fields) => loggers.error.error({ err, ...fields }, 'gateway-pool'),
    },
    handle: async (command, payload, frame) => {
      const trace = new AiTrace(
        loggers.error,
        { correlationId: frame.correlationId, command, messageId: frame.messageId },
        '',
        'gateway-rpc',
        config.VERBOSE
      );
      return withAiTrace(trace, async () => {
        try {
          return await trace.step('gateway-rpc.handle', () => remoteDownloads.handle(command, payload));
        } catch (error) {
          trace.fail(error);
          throw error;
        }
      });
    },
  });
  const remoteClientService = new RemoteClientService(
    new MongoRemoteAuthorizationStore(models.users, models.remoteDevices),
    new AuthorizationGatewayClient(gatewayPool),
    new SecretCrypto(config.INTEGRATION_SECRET_KEY)
  );
  shutdown.register('gateway_pool', 70, () => gatewayPool.stop());
  const remoteClientWorker = new RemoteClientWorker(remoteClientService, {
    logger: loggers.error,
    verbose: config.VERBOSE,
  });
  shutdown.register('remote_client_notifications', 31, () => remoteClientWorker.stop());
  remoteClientWorker.start();
  const userStore = new MongoAuthUserStore(models.users, models.authIdentities);
  const sessionStore = new RedisSessionStore(
    infrastructure.redis.getClient(),
    config.SESSION_TOKEN_PEPPER,
    config.SESSION_TTL_SECONDS
  );
  const authService = new AuthService(userStore, sessionStore, config.REGISTRATION_USER_LIMIT);
  const externalUsageService = new ExternalUsageService(authService, externalUsageStore);
  const avatarStore = new MinioAvatarStore(infrastructure.minio.getClient(), config.MINIO_BUCKET);
  const userService = new UserService(
    authService,
    userStore,
    avatarStore,
    config.AVATAR_MAX_BYTES,
    config.AVATAR_MAX_PIXELS
  );
  const trendingStore = new MongoTrendingStore(
    models.movies,
    models.movieLocalizations,
    models.movieResultSets,
    models.people,
    models.movieCredits,
    models.trendingStates
  );
  const tmdb = new TmdbClient(
    config.TMDB_READ_ACCESS_TOKEN,
    config.TMDB_REQUEST_TIMEOUT_MS,
    undefined,
    undefined,
    externalUsageStore
  );
  const trendingSync = new TrendingSyncService(
    tmdb,
    trendingStore,
    new RedisSyncLock(infrastructure.redis.getClient(), config.REDIS_LOCK_TRACE_ENABLED, loggers.app),
    config.TMDB_LANGUAGE,
    config.TRENDING_SYNC_LOCK_TTL_SECONDS,
    {
      info: (bindings, message) => loggers.app.info(bindings, message),
      error: (bindings, message) => loggers.error.error(bindings, message),
    }
  );
  const movieStatusStore = new MongoMovieStatusStore(models.userMovieStates);
  const mteamEndpoints = { baseUrl: config.MTEAM_BASE_URL, webBaseUrl: config.MTEAM_WEB_BASE_URL };
  const integrationConfigStore = withMTeamEndpoints(
    new MongoIntegrationConfigStore(models.integrationConfigs),
    mteamEndpoints
  );
  const mteam = new MTeamClient(config.MTEAM_REQUEST_TIMEOUT_MS, externalUsageStore, {
    minimumIntervalMs: config.MTEAM_SEARCH_MIN_INTERVAL_MS,
    logger: loggers.error,
    verbose: config.VERBOSE,
  });
  const secrets = new SecretCrypto(config.INTEGRATION_SECRET_KEY);
  const movieResourceCheckStore = new MongoMovieResourceCheckStore(
    models.movieResourceChecks,
    models.movieResourceCheckTasks
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
    }
  );
  const movieService = new MovieService(trendingStore, trendingSync, tmdb, trendingStore, movieStatusStore);
  await Promise.all([models.integrationConfigs.init(), models.resourceSiteCredentials.init()]);
  const hdarea = new HDAreaAdapter(config.HDAREA_BASE_URL);
  const resourceSiteService = new ResourceSiteService(
    new Map([[hdarea.id, hdarea]]),
    new MongoResourceSiteCredentialStore(models.resourceSiteCredentials),
    secrets,
    new HDAreaHttpClient(),
    { logger: loggers.error, verbose: config.VERBOSE }
  );
  await new SiteAccountMigrationService(
    new MongoSiteAccountMigrationStore(models.integrationConfigs, models.resourceSiteCredentials),
    mteam,
    config.MTEAM_BASE_URL,
    resourceSiteService.registry,
    new HDAreaHttpClient(),
    secrets,
    { logger: loggers.error, verbose: config.VERBOSE }
  ).migrate();
  const resourceSearchService = new ResourceSearchService([
    new MTeamSearchSource(integrationConfigStore, secrets, mteam),
    ...[...resourceSiteService.registry.values()].map((site) => {
      return new ResourceSiteSearchSource(site.id, site.name, resourceSiteService);
    }),
  ]);
  const integrationService = new IntegrationService(
    authService,
    integrationConfigStore,
    mteam,
    secrets,
    new Set([...config.MTEAM_ALLOWED_HOSTS, new URL(config.MTEAM_BASE_URL).hostname]),
    undefined,
    mteamEndpoints
  );
  const transmissionConfigStore = new MongoTransmissionConfigStore(models.transmissionConfigs);
  const transmission = new TransmissionClient(config.TRANSMISSION_REQUEST_TIMEOUT_MS);
  const transmissionIntegrationService = new TransmissionIntegrationService(
    authService,
    transmissionConfigStore,
    transmission,
    secrets
  );
  const qbittorrentConfigStore = new MongoQBittorrentConfigStore(models.qbittorrentConfigs);
  const qbittorrent = new QBittorrentClient(config.QBITTORRENT_REQUEST_TIMEOUT_MS);
  const qbittorrentIntegrationService = new QBittorrentIntegrationService(
    authService,
    qbittorrentConfigStore,
    qbittorrent,
    secrets
  );
  const openaiConfigStore = new MongoOpenAIConfigStore(models.openaiConfigs);
  await models.integrationPreferences.init();
  const integrationPreferencesService = new IntegrationPreferencesService(
    new MongoIntegrationPreferencesStore(models.integrationPreferences),
    async (ownerId) => {
      const [resources, qb, tr, ai] = await Promise.all([
        resourceSearchService.list(ownerId),
        qbittorrentConfigStore.list(ownerId),
        transmissionConfigStore.list(ownerId),
        openaiConfigStore.find(ownerId),
      ]
      );
      return [
        ...resources.sources.map((source) => ({ ...source, category: 'resource' as const })),
        ...qb.map((instance) => ({
          id: instance.downloaderInstanceId!,
          name: instance.name ?? 'qBittorrent',
          category: 'downloader' as const,
          status: instance.lastFailureType
            ? ('configured_invalid' as const)
            : instance.verifiedAt
              ? ('configured_valid' as const)
              : ('configured_unverified' as const),
        })),
        ...tr.map((instance) => ({
          id: instance.downloaderInstanceId!,
          name: instance.name ?? 'Transmission',
          category: 'downloader' as const,
          status: instance.lastFailureType
            ? ('configured_invalid' as const)
            : instance.verifiedAt
              ? ('configured_valid' as const)
              : ('configured_unverified' as const),
        })),
        {
          id: 'openai',
          name: 'OpenAI',
          category: 'ai' as const,
          status: !ai
            ? ('unconfigured' as const)
            : ai.validation?.status === 'valid'
              ? ('configured_valid' as const)
              : ai.validation?.status === 'failed'
                ? ('configured_invalid' as const)
                : ('configured_unverified' as const),
        },
      ];
    });
  for (const service of [
    integrationService,
    transmissionIntegrationService,
    qbittorrentIntegrationService,
    resourceSiteService,
  ])
    service.preferences = integrationPreferencesService;
  const movieSiteResourcesService = new MovieSiteResourcesService(
    movieResourceCheckStore,
    movieResourceChecks,
    integrationPreferencesService,
    resourceSearchService,
    resourceSiteService,
    trendingStore,
    tmdb,
    config.TMDB_LANGUAGE,
    { logger: loggers.error, verbose: config.VERBOSE },
    config.MTEAM_RESOURCE_AVAILABLE_TTL_SECONDS * 1_000
  );
  await Promise.all([
    models.remoteControl.commands.init(),
    models.remoteControl.receipts.init(),
    models.movieDownloads.init(),
  ]);
  const remoteDownloads = new RemoteDownloadService({
    diagnostics: { logger: loggers.error, verbose: config.VERBOSE },
    store: new MongoRemoteControlStore(models.users, models.remoteDevices, models.movieDownloads, models.remoteControl),
    report: (err, fields) => loggers.error.error({ err, ...fields }, 'remote-download'),
    torrent: async (command, download) => {
      await movieSiteResourcesService.releaseForDownload(
        command.ownerId,
        download.tmdbId,
        command.source,
        command.resourceId
      );
      let url: string;
      if (command.source === 'hdarea')
        url = await resourceSiteService.torrentUrl(command.ownerId, 'hdarea', command.resourceId);
      else {
        const credentials = await integrationConfigStore.find(command.ownerId, 'mteam');
        if (!credentials) throw new RpcError('RESOURCE_SITE_NOT_CONFIGURED', 'not_applied');
        url = await mteam.torrentUrl(
          credentials.baseUrl,
          secrets.decrypt(credentials.encryptedApiKey, integrationSecretContext(command.ownerId, 'mteam')),
          command.resourceId
        );
      }
      currentAiTrace()?.sensitive(url);
      return { url, torrentHash: await readTorrentMetadata(url) };
    },
  });
  const remoteDownloadCoordinator = new RemoteDownloadCoordinator(gatewayPool, remoteDownloads);
  const remoteDownloadWorker = new RemoteDownloadWorker(remoteDownloads, remoteDownloadCoordinator);
  shutdown.register('remote_downloads', 32, () => remoteDownloadWorker.stop());
  await remoteDownloads.sweep();
  remoteDownloadWorker.start();
  gatewayPool.start();
  const movieStatusService = new MovieStatusService(
    movieStatusStore,
    trendingStore,
    config.TMDB_LANGUAGE,
    {
      schedule: (ownerId, tmdbId, options) => movieSiteResourcesService.schedule(ownerId, tmdbId, options),
      request: (ownerId, tmdbId, force) => movieResourceChecks.request(ownerId, tmdbId, force),
      listReleases: (ownerId, tmdbId) => movieResourceChecks.listReleases(ownerId, tmdbId),
    },
    movieResourceCheckStore,
    movieSiteResourcesService
  );
  const movieResourceSyncService = new MovieResourceSyncService(
    movieStatusStore,
    movieResourceCheckStore,
    movieSiteResourcesService,
    new MongoMovieResourceSyncBatchStore(models.movieResourceSyncBatches),
    config.MTEAM_RESOURCE_RETRY_DELAY_SECONDS * 1_000,
    config.MTEAM_RESOURCE_CHECK_LEASE_SECONDS * 1_000,
    {
      info: (bindings, message) => loggers.app.info(bindings, message),
      error: (bindings, message) => loggers.error.error(bindings, message),
    }
  );
  movieResourceSyncService.verbose = config.VERBOSE;
  await models.telegramBindings.init();
  await models.assistantMessages.init();
  const assistantQueue = new MongoAssistantQueue(models.assistantMessages);
  const assistantReceiver = new AssistantMessageReceiver(
    assistantQueue,
    (input) => {
      return assistantWorker.wake(input);
    },
    loggers.app
  );
  const telegramClient = config.TELEGRAM_BOT_TOKEN
    ? new TelegramClient(config.TELEGRAM_BOT_TOKEN, undefined, loggers.app, config.TELEGRAM_POLL_TRACE_ENABLED)
    : undefined;
  const receiveMessage = async (
    ownerId: string,
    message: import('./modules/incoming-message.types.js').IncomingMessage
  ) => {
    await assistantReceiver.receive(ownerId, message);
    loggers.app.info(
      {
        event: 'incoming_message',
        ownerId,
        channel: message.channel,
        messageId: message.messageId,
        messageType: message.messageType,
      },
      'User message received'
    );
  };
  const telegramService = new TelegramService(
    authService,
    new MongoTelegramStore(models.telegramBindings),
    telegramClient,
    undefined,
    receiveMessage,
    loggers.app
  );
  const telegramWorker
    = telegramClient && config.TELEGRAM_BOT_TOKEN
      ? new TelegramWorker(
          infrastructure.redis.getClient(),
          config.TELEGRAM_BOT_TOKEN,
          telegramClient,
          telegramService,
          () => {
            return loggers.app.warn(
              'Telegram polling failed; check connectivity, token, and that no webhook or external poller uses this bot'
            );
          },
          loggers.app,
          config.REDIS_LOCK_TRACE_ENABLED,
          config.TELEGRAM_POLL_TRACE_ENABLED
        )
      : undefined;
  shutdown.register('telegram_worker', 10, () => telegramWorker?.stop());
  loggers.app.info(
    { event: 'telegram_configuration', enabled: Boolean(telegramWorker) },
    'Telegram polling configuration'
  );
  await models.whatsappSessions.init();
  const whatsappService = new WhatsAppService(
    authService,
    new MongoWhatsAppStore(models.whatsappSessions, secrets),
    connectBaileys,
    (ownerId, event) => {
      return loggers.app.info({ ownerId, ...event }, 'WhatsApp connection lifecycle');
    },
    receiveMessage
  );
  shutdown.register('whatsapp_sessions', 40, () => whatsappService.close());
  await Promise.all([models.movieDownloads.init(), models.notificationPreferences.init()]);
  const notificationService = new NotificationService(
    authService,
    new MongoNotificationStore(models.movieDownloads, models.notificationPreferences),
    [
      {
        id: 'telegram',
        name: 'Telegram',
        isConfigured: (ownerId) => {
          return telegramService.isConfigured(ownerId);
        },
        send: (ownerId, notification) => telegramService.sendNotification(ownerId, notification),
      },
      {
        id: 'whatsapp',
        name: 'WhatsApp',
        isConfigured: (ownerId) => {
          return whatsappService.isConfigured(ownerId);
        },
        send: (ownerId, notification) => whatsappService.sendNotification(ownerId, notification),
      },
    ]
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
    undefined,
    { configs: transmissionConfigStore, client: transmission },
    notificationService,
    { resources: movieSiteResourcesService, sites: resourceSiteService }
  );
  movieDownloadService.remote = new RemoteMovieDownloadService(new MongoMovieDownloadStore(models.movieDownloads),
    remoteClientService, remoteDownloadCoordinator);
  movieDownloadService.preferences = integrationPreferencesService;
  const conversationStore = new MongoConversationStore(models.conversationThreads, models.conversationMessages);
  const conversationService = new ConversationService(authService, conversationStore);
  const openaiSettingsService = new OpenAISettingsService(authService, openaiConfigStore, secrets, {
    model: config.OPENAI_MODEL,
    recommendedModels: config.OPENAI_RECOMMENDED_MODELS,
    verify: (apiKey) => {
      return probeOpenAI(
        new OpenAI({ apiKey, timeout: Math.min(config.OPENAI_REQUEST_TIMEOUT_MS, 20_000), maxRetries: 0 })
      );
    },
  });
  openaiSettingsService.preferences = integrationPreferencesService;
  const createOwnerLlmClient = async (ownerId: string) => {
    const { apiKey, model } = await openaiSettingsService.requireCredentials(ownerId);
    return new OpenAILlmClient(
      new OpenAI({ apiKey, timeout: config.OPENAI_REQUEST_TIMEOUT_MS, maxRetries: 0 }),
      model,
      { ownerId, recorder: externalUsageStore, maxRetries: config.OPENAI_MAX_RETRIES }
    );
  };
  const preferenceModels = createPreferenceModels(models.users.db);
  await Promise.all(Object.values(preferenceModels).map((model) => model.init()));
  const preferenceStore = new MongoPreferenceStore(preferenceModels);
  const preferenceService = new PreferenceService(
    preferenceStore,
    movieStatusStore,
    trendingStore,
    tmdb,
    config.TMDB_LANGUAGE,
    (ownerId) => openaiSettingsService.requireCredentials(ownerId)
  );
  const preferenceWorkflow = new PreferenceWorkflow(
    preferenceStore,
    new PreferenceAgent(createOwnerLlmClient, config.OPENAI_MAX_CONTEXT_TOKENS),
    (job, signal) => preferenceService.enrich(job, signal)
  );
  const preferenceWorker = new PreferenceWorker(preferenceStore, preferenceWorkflow, loggers.error, config.VERBOSE);
  shutdown.register('preference_worker', 21, () => preferenceWorker.stop());
  const recommendationModel = createRecommendationModel(models.users.db);
  await recommendationModel.init();
  const recommendations = new RecommendationTool(
    new MongoRecommendationStore(recommendationModel),
    preferenceStore,
    tmdb,
    trendingStore,
    movieStatusStore,
    config.TMDB_LANGUAGE,
    { logger: loggers.error, verbose: config.VERBOSE }
  );
  const resourceQueryModel = createResourceQueryModel(models.users.db);
  await resourceQueryModel.init();
  await initializeAssistantRetention(models.assistantMessages, resourceQueryModel, {
    logger: loggers.error,
    verbose: config.VERBOSE,
  });
  const resources = new ResourceQueryTool(
    new MongoResourceQueryStore(resourceQueryModel),
    [
      new MTeamResourceProvider(movieResourceChecks),
      ...[...resourceSiteService.registry.values()].map((site) => {
        return new ResourceSiteResourceProvider(
          site.id,
          site.name,
          resourceSiteService,
          trendingStore,
          config.TMDB_LANGUAGE
        );
      }),
    ],
    tmdb,
    trendingStore,
    config.TMDB_LANGUAGE,
    { logger: loggers.error, verbose: config.VERBOSE }
  );
  const assistantSessionModel = createAssistantSessionModel(models.users.db);
  await assistantSessionModel.init();
  const assistantOptions = {
    locale: config.TMDB_LANGUAGE,
    sessions: new MongoAssistantSessionStore(assistantSessionModel),
    downloads: movieDownloadService,
    diagnostics: { logger: loggers.error, verbose: config.VERBOSE },
    systemPrompt: config.OPENAI_SYSTEM_PROMPT,
    maxContextTokens: config.OPENAI_MAX_CONTEXT_TOKENS,
    maxOutputTokens: config.OPENAI_MAX_OUTPUT_TOKENS,
    preferences: preferenceService,
    recommendations,
    resources,
    report: (event: string) => loggers.app.warn({ event }, 'Assistant capability failed'),
  };
  const conversationTurnService = new ConversationTurnService(
    conversationStore,
    createOwnerLlmClient,
    new Utf8ByteTokenCounter(),
    {
      systemPrompt: config.OPENAI_SYSTEM_PROMPT,
      maxContextTokens: config.OPENAI_MAX_CONTEXT_TOKENS,
      maxOutputTokens: config.OPENAI_MAX_OUTPUT_TOKENS,
      summaryMaxOutputTokens: config.OPENAI_SUMMARY_MAX_OUTPUT_TOKENS,
      historyLimit: config.OPENAI_HISTORY_LIMIT,
      safetyMarginTokens: 256,
      messageOverheadTokens: 4,
      reply: createAssistantConversationReply(assistantOptions),
    }
  );

  const assistantWorkflow = new AssistantWorkflow(createOwnerLlmClient, assistantOptions);
  const assistantWorker = new AssistantWorker(
    infrastructure.redis.getClient(),
    assistantQueue,
    assistantWorkflow,
    (input, text, poster) => {
      return input.channel === 'telegram'
        ? telegramService.reply(input.ownerId, input.chatId, text, poster)
        : whatsappService.reply(input.ownerId, input.chatId, text, poster);
    },
    (input) => {
      return input.channel === 'telegram'
        ? telegramService.canReply(input.ownerId, input.chatId)
        : whatsappService.canReply(input.ownerId, input.chatId);
    },
    (event) => loggers.app.warn({ event }, 'Assistant workflow'),
    {
      maxConcurrency: config.ASSISTANT_MAX_CONCURRENCY,
      scanIntervalMs: config.ASSISTANT_SCAN_INTERVAL_MS,
      scanTraceEnabled: config.SCAN_TRACE_ENABLED,
      verbose: config.VERBOSE,
      setTyping: (input, active, signal) => {
        return input.channel === 'telegram'
          ? telegramService.setTyping(input.ownerId, input.chatId, active, signal)
          : whatsappService.setTyping(input.ownerId, input.chatId, active, signal);
      },
    },
    loggers.app,
    config.REDIS_LOCK_TRACE_ENABLED
  );

  shutdown.register('assistant_worker', 20, () => assistantWorker.stop());
  const notificationWorker = new NotificationWorker(
    notificationService,
    movieDownloadService,
    trendingStore,
    config.TMDB_LANGUAGE,
    config.WEB_ORIGIN,
    (event, fields) => {
      if (event === 'SCAN_STARTED' || event === 'SCAN_COMPLETED')
        loggers.app.info({ event, ...fields }, 'Download notification scan');
      else loggers.app.warn({ event, ...fields }, 'Download notification worker');
    },
    undefined,
    undefined,
    config.SCAN_TRACE_ENABLED
  );
  shutdown.register('notification_worker', 30, () => notificationWorker.stop());
  const notificationTestService = new NotificationTestService(
    authService,
    new MongoNotificationTestStore(models.movieDownloads),
    notificationService,
    trendingStore,
    config.TMDB_LANGUAGE,
    config.WEB_ORIGIN
  );
  const app = await buildApp({
    remoteClientService,
    remoteDownloadCoordinator,
    resourceSiteService,
    resourceSearchService,
    integrationPreferencesService,
    movieSiteResourcesService,
    preferenceService,
    telegramService,
    notificationTestService,
    notificationService,
    whatsappService,
    config,
    healthDependencies: infrastructure.healthDependencies,
    authService,
    userService,
    movieService,
    movieStatusService,
    integrationService,
    movieResourceSyncService,
    transmissionIntegrationService,
    qbittorrentIntegrationService,
    movieDownloadService,
    externalUsageService,
    conversationService,
    openaiSettingsService,
    conversationTurnService,
  });
  shutdown.register('resource_sync', 60, () => movieResourceSyncService.stop());
  shutdown.register('resource_checks', 70, async () => {
    await movieSiteResourcesService.stop();
    await movieResourceChecks.stop();
  });
  shutdown.register('http_server', 50, () => app.close());
  app.addHook('onRequest', async (_request, reply) => {
    if (shutdown.requested)
      return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE', message: 'Application is shutting down' });
  });
  shutdown.assertRunning();
  await movieResourceSyncService.resumePending();
  shutdown.assertRunning();
  externalUsageAggregation.start();
  notificationWorker.start();
  telegramWorker?.start();
  const linkedWhatsAppOwners = await models.whatsappSessions
    .find({ encryptedState: { $exists: true } })
    .select('ownerId')
    .lean();
  shutdown.assertRunning();
  await whatsappService.resume(linkedWhatsAppOwners.map((row) => String(row.ownerId)));
  shutdown.assertRunning();
  assistantWorker.start();
  preferenceWorker.start();

  await app.listen({ host: config.HOST, port: config.PORT });
  shutdown.assertRunning();
  loggers.app.info({ host: config.HOST, port: config.PORT }, 'API listening');
} catch (error) {
  if (!shutdown.requested) {
    loggers.error.fatal({ err: error }, 'API startup failed');
    // The handler owns process termination after the startup barrier is released.
    shutdownHandlers.request('startup_failure', error);
  }
} finally {
  finishStartup();
}
