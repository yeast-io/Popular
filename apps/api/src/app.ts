import { randomUUID } from 'node:crypto';
import { registerOpenAISettingsRoutes } from './modules/integrations/openai-settings.routes.js';
import type { OpenAISettingsService } from './modules/integrations/openai-settings.service.js';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config/env.js';
import type { HealthDependency } from './infrastructure/health/dependency.js';
import { registerErrorHandler } from './infrastructure/http/error-handler.js';
import { registerAccessLog } from './infrastructure/logging/access-log.js';
import { createLoggers, createPrettyLoggers } from './infrastructure/logging/logger.js';
import { registerHealthRoutes } from './modules/health/health.routes.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import type { AuthService } from './modules/auth/auth.service.js';
import { registerUserRoutes } from './modules/users/user.routes.js';
import type { UserService } from './modules/users/user.service.js';
import { registerMovieRoutes } from './modules/movies/movie.routes.js';
import type { MovieService } from './modules/movies/movie.service.js';
import { registerMovieStatusRoutes } from './modules/movie-statuses/movie-status.routes.js';
import type { MovieStatusService } from './modules/movie-statuses/movie-status.service.js';
import { registerIntegrationRoutes } from './modules/integrations/integration.routes.js';
import type { IntegrationService } from './modules/integrations/integration.service.js';
import type { MovieResourceSyncService } from './modules/integrations/movie-resource-sync.service.js';
import { registerTransmissionRoutes } from './modules/integrations/transmission.routes.js';
import type { TransmissionIntegrationService } from './modules/integrations/transmission-integration.service.js';
import type { QBittorrentIntegrationService } from './modules/integrations/qbittorrent-integration.service.js';
import { registerMovieDownloadRoutes } from './modules/downloads/movie-download.routes.js';
import type { MovieDownloadService } from './modules/downloads/movie-download.service.js';
import { registerExternalUsageRoutes } from './modules/external-usage/external-usage.routes.js';
import type { ExternalUsageService } from './modules/external-usage/external-usage.service.js';
import { registerPublicConfigRoutes } from './modules/config/public-config.routes.js';
import { registerConversationRoutes } from './modules/conversations/conversation.routes.js';
import type { ConversationService } from './modules/conversations/conversation.service.js';
import type { ConversationTurnService } from './modules/conversations/conversation-turn.service.js';

export interface BuildAppOptions {
  config: AppConfig;
  healthDependencies: HealthDependency[];
  authService?: AuthService;
  userService?: UserService;
  movieService?: MovieService;
  movieStatusService?: MovieStatusService;
  integrationService?: IntegrationService;
  movieResourceSyncService?: MovieResourceSyncService;
  transmissionIntegrationService?: TransmissionIntegrationService;
  qbittorrentIntegrationService?: QBittorrentIntegrationService;
  movieDownloadService?: MovieDownloadService;
  externalUsageService?: ExternalUsageService;
  openaiSettingsService?: OpenAISettingsService;
  conversationService?: ConversationService;
  conversationTurnService?: ConversationTurnService;
}

export async function buildApp({ config, healthDependencies, authService, userService, movieService, movieStatusService, integrationService, movieResourceSyncService, transmissionIntegrationService, qbittorrentIntegrationService, movieDownloadService, externalUsageService, conversationService, conversationTurnService, openaiSettingsService }: BuildAppOptions): Promise<FastifyInstance> {
  const loggers = createLoggers(config.LOG_LEVEL);
  const logger = createPrettyLoggers();
  logger.info('start to build application');
  const app = Fastify({ logger: false, trustProxy: config.trustProxy, genReqId: () => randomUUID() });

  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  registerAccessLog(app, config.ACCESS_LOG_ENABLED);
  registerErrorHandler(app, loggers);

  await app.register(async (api) => {
    if (openaiSettingsService) registerOpenAISettingsRoutes(api, openaiSettingsService, config);
    registerPublicConfigRoutes(api, config);
    registerHealthRoutes(api, healthDependencies);
    if (authService) registerAuthRoutes(api, authService, config);
    if (userService) registerUserRoutes(api, userService, config);
    if (movieService) registerMovieRoutes(api, movieService, authService, config);
    if (movieStatusService && authService) registerMovieStatusRoutes(api, movieStatusService, authService, config, movieResourceSyncService);
    if (transmissionIntegrationService) registerTransmissionRoutes(api, transmissionIntegrationService, config);
    if (integrationService) registerIntegrationRoutes(api, integrationService, config, qbittorrentIntegrationService);
    if (movieDownloadService) registerMovieDownloadRoutes(api, movieDownloadService, config);
    if (externalUsageService) registerExternalUsageRoutes(api, externalUsageService, config);
    if (conversationService) registerConversationRoutes(api, conversationService, config, conversationTurnService, authService, loggers.error);
  }, { prefix: '/api/v1' });

  return app;
}
