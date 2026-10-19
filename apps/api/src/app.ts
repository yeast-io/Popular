import type { BuildAppOptions } from './app.types.js';
import { DocsService } from './modules/docs/docs.service.js';
import { registerDocsRoutes } from './modules/docs/docs.routes.js';
import { aiAssistantPageEnabled, docsPageEnabled } from './config/env.js';
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
  docsService,
  telegramService,
  notificationTestService,
  notificationService,
  whatsappService,
  config,
  healthDependencies,
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
      if (telegramService) registerTelegramRoutes(api, telegramService, config);
      if (notificationTestService) registerNotificationTestRoutes(api, notificationTestService, config);
      if (notificationService) registerNotificationRoutes(api, notificationService, config);
      if (whatsappService) registerWhatsAppRoutes(api, whatsappService, config);
      if (openaiSettingsService) registerOpenAISettingsRoutes(api, openaiSettingsService, config);
      registerPublicConfigRoutes(api, config);
      if (docsPageEnabled(config) && authService)
        registerDocsRoutes(api, docsService ?? new DocsService(), authService, config, loggers.error);
      registerHealthRoutes(api, healthDependencies);
      if (authService) registerAuthRoutes(api, authService, config);
      if (preferenceService && authService) registerPreferenceRoutes(api, preferenceService, authService, config);
      if (userService) registerUserRoutes(api, userService, config);
      if (movieService) registerMovieRoutes(api, movieService, authService, config);
      if (movieStatusService && authService)
        registerMovieStatusRoutes(api, movieStatusService, authService, config, movieResourceSyncService);
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
          loggers.error,
        );
    },
    { prefix: '/api/v1' },
  );

  return app;
}
