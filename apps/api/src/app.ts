import { registerTvPreferenceRoutes } from './modules/tv-preferences/tv-preference.routes.js';
import { registerWatchlistRoutes } from './modules/watchlist/watchlist.routes.js';
import { registerTvShowRoutes } from './modules/tv-shows/tv-show.routes.js';
import { registerRemoteClientRoutes } from './modules/remote-clients/remote-client.routes.js';
import { registerIntegrationPreferencesRoutes } from './modules/integrations/integration-preferences.routes.js';
import { registerResourceSearchRoutes } from './modules/resource-search/resource-search.routes.js';
import { registerResourceSiteRoutes } from './modules/resource-sites/resource-site.routes.js';
import type { BuildAppOptions } from './app.types.js';
import { aiAssistantPageEnabled } from './config/env.js';
import { registerTelegramRoutes } from './modules/telegram/telegram.routes.js';
import { registerPreferenceRoutes } from './modules/preferences/preference.routes.js';

import { registerNotificationTestRoutes } from './modules/notifications/notification-test.routes.js';

import { registerNotificationRoutes } from './modules/notifications/notification.routes.js';

import { registerWhatsAppRoutes } from './modules/whatsapp/whatsapp.routes.js';

import { randomUUID } from 'node:crypto';
import { registerOpenAISettingsRoutes } from './modules/integrations/openai-settings.routes.js';

import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerErrorHandler } from './infrastructure/http/error-handler.js';
import { registerAccessLog } from './infrastructure/logging/access-log.js';
import { createLoggers, createPrettyLoggers } from './infrastructure/logging/logger.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';

import { registerUserRoutes } from './modules/users/user.routes.js';

import { registerMovieRoutes } from './modules/movies/movie.routes.js';

import { registerMovieStatusRoutes } from './modules/movie-statuses/movie-status.routes.js';

import { registerIntegrationRoutes } from './modules/integrations/integration.routes.js';

import { registerTransmissionRoutes } from './modules/integrations/transmission.routes.js';

import { registerMovieDownloadRoutes } from './modules/downloads/movie-download.routes.js';

import { registerExternalUsageRoutes } from './modules/external-usage/external-usage.routes.js';

import { registerPublicConfigRoutes } from './modules/config/public-config.routes.js';
import { registerConversationRoutes } from './modules/conversations/conversation.routes.js';

export async function buildApp({
  remoteClientService,
  resourceSiteService,
  resourceSearchService,
  integrationPreferencesService,
  movieSiteResourcesService,
  telegramService,
  notificationTestService,
  notificationService,
  whatsappService,
  config,
  healthDependencies,
  authService,
  userService,
  movieService,
  tvPreferenceService,
  watchlistService,
  tvShowService,
  tvSeasonService,
  tvTrendingService,
  movieStatusService,
  integrationService,
  movieResourceSyncService,
  transmissionIntegrationService,
  qbittorrentIntegrationService,
  movieDownloadService,
  externalUsageService,
  conversationService,
  conversationTurnService,
  openaiSettingsService,
  preferenceService,
}: BuildAppOptions): Promise<FastifyInstance> {
  const loggers = createLoggers(config.LOG_LEVEL);
  const logger = createPrettyLoggers();
  logger.info('start to build application');
  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    genReqId: () => {
      return randomUUID();
    },
  });

  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  registerAccessLog(app, config.ACCESS_LOG_ENABLED);
  registerErrorHandler(app, loggers);

  await app.register(
    async (api) => {
      if (remoteClientService && authService)
        registerRemoteClientRoutes(api, remoteClientService, authService, config, loggers.error);
      if (integrationPreferencesService && authService)
        registerIntegrationPreferencesRoutes(
          api,
          integrationPreferencesService,
          authService,
          config,
          loggers.error,
          movieSiteResourcesService,
          movieResourceSyncService
        );
      if (resourceSearchService && authService)
        registerResourceSearchRoutes(api, resourceSearchService, authService, config, loggers.error);
      if (resourceSiteService && authService)
        registerResourceSiteRoutes(api, resourceSiteService, authService, config, loggers.error);
      if (telegramService) registerTelegramRoutes(api, telegramService, config);
      if (notificationTestService) registerNotificationTestRoutes(api, notificationTestService, config);
      if (notificationService) registerNotificationRoutes(api, notificationService, config);
      if (whatsappService) registerWhatsAppRoutes(api, whatsappService, config);
      if (openaiSettingsService) registerOpenAISettingsRoutes(api, openaiSettingsService, config);
      registerPublicConfigRoutes(api, config);
      registerHealthRoutes(api, healthDependencies);
      if (authService) registerAuthRoutes(api, authService, config);
      if (preferenceService && authService) registerPreferenceRoutes(api, preferenceService, authService, config);
      if (userService) registerUserRoutes(api, userService, config);
      if (tvShowService && tvSeasonService && tvTrendingService) registerTvShowRoutes(api, tvShowService, tvSeasonService, tvTrendingService, config, { logger: loggers.error, verbose: config.VERBOSE }, authService, tvPreferenceService);
      if (tvPreferenceService && authService) registerTvPreferenceRoutes(api, tvPreferenceService, authService, config, loggers.error);
      if (watchlistService && authService) registerWatchlistRoutes(api, watchlistService, authService, config, loggers.error);
      if (movieService) registerMovieRoutes(api, movieService, authService, config);
      if (movieStatusService && authService)
        registerMovieStatusRoutes(
          api,
          movieStatusService,
          authService,
          config,
          movieResourceSyncService,
          Boolean(movieSiteResourcesService)
        );
      if (transmissionIntegrationService) registerTransmissionRoutes(api, transmissionIntegrationService, config);
      if (integrationService) registerIntegrationRoutes(api, integrationService, config, qbittorrentIntegrationService);
      if (movieDownloadService) registerMovieDownloadRoutes(api, movieDownloadService, config);
      if (externalUsageService) registerExternalUsageRoutes(api, externalUsageService, config);
      if (aiAssistantPageEnabled(config) && conversationService)
        registerConversationRoutes(
          api,
          conversationService,
          config,
          conversationTurnService,
          authService,
          loggers.error
        );
    },
    { prefix: '/api/v1' }
  );

  return app;
}
