import { createRemoteCommandModels } from './remote-downloads/remote-command.schema.js';
import { createRemoteDeviceModel } from './remote-clients/remote-authorization.schema.js';
import { createIntegrationPreferencesModel } from './integrations/integration-preferences.schema.js';

import { createResourceSiteCredentialModel } from './resource-sites/resource-site-credential.schema.js';
import { createTelegramModel } from './telegram/telegram.schema.js';
import { createAssistantMessageModel } from './assistant/assistant-message.schema.js';
import { createNotificationPreferencesModel } from './notifications/notification-preferences.schema.js';
import { createWhatsAppModel } from './whatsapp/whatsapp.schema.js';
import { createOpenAIConfigModel } from './integrations/openai-config.schema.js';
import type { Connection } from 'mongoose';
import { createAuthIdentityModel } from './users/auth-identity.schema.js';
import { createMovieResultSetModel } from './movies/movie-result-set.schema.js';
import { createMovieModel } from './movies/movie.schema.js';
import { createMovieLocalizationModel } from './movies/movie-localization.schema.js';
import { createSyncJobModel } from './sync/sync-job.schema.js';
import { createUserMovieStateModel } from './movie-statuses/user-movie-state.schema.js';
import { createUserModel } from './users/user.schema.js';
import { createPersonModel } from './movies/person.schema.js';
import { createMovieCreditModel } from './movies/movie-credit.schema.js';
import { createIntegrationConfigModel } from './integrations/integration-config.schema.js';
import { createMovieResourceCheckModel } from './movie-resources/movie-resource-check.schema.js';
import { createMovieResourceCheckTaskModel } from './movie-resources/movie-resource-check-task.schema.js';
import { createMovieResourceSyncBatchModel } from './movie-resources/movie-resource-sync-batch.schema.js';
import { createTrendingStateModel } from './sync/trending-state.schema.js';
import { createTransmissionConfigModel } from './integrations/transmission-config.schema.js';
import { createQBittorrentConfigModel } from './integrations/qbittorrent-config.schema.js';
import { createMovieDownloadModel } from './downloads/movie-download.schema.js';
import { createExternalRequestEventModel } from './external-usage/external-request-event.schema.js';
import { createExternalUsageDailyModel } from './external-usage/external-usage-daily.schema.js';
import { createConversationThreadModel } from './conversations/conversation-thread.schema.js';
import { createConversationMessageModel } from './conversations/conversation-message.schema.js';

export function createModels(connection: Connection) {
  return {
    remoteControl: createRemoteCommandModels(connection),
    remoteDevices: createRemoteDeviceModel(connection),
    integrationPreferences: createIntegrationPreferencesModel(connection),
    resourceSiteCredentials: createResourceSiteCredentialModel(connection),
    assistantMessages: createAssistantMessageModel(connection),
    telegramBindings: createTelegramModel(connection),
    notificationPreferences: createNotificationPreferencesModel(connection),
    whatsappSessions: createWhatsAppModel(connection),
    openaiConfigs: createOpenAIConfigModel(connection),
    users: createUserModel(connection),
    authIdentities: createAuthIdentityModel(connection),
    movies: createMovieModel(connection),
    movieLocalizations: createMovieLocalizationModel(connection),
    movieResultSets: createMovieResultSetModel(connection),
    userMovieStates: createUserMovieStateModel(connection),
    syncJobs: createSyncJobModel(connection),
    people: createPersonModel(connection),
    movieCredits: createMovieCreditModel(connection),
    integrationConfigs: createIntegrationConfigModel(connection),
    movieResourceChecks: createMovieResourceCheckModel(connection),
    movieResourceCheckTasks: createMovieResourceCheckTaskModel(connection),
    movieResourceSyncBatches: createMovieResourceSyncBatchModel(connection),
    trendingStates: createTrendingStateModel(connection),
    transmissionConfigs: createTransmissionConfigModel(connection),
    qbittorrentConfigs: createQBittorrentConfigModel(connection),
    movieDownloads: createMovieDownloadModel(connection),
    externalRequestEvents: createExternalRequestEventModel(connection),
    externalUsageDaily: createExternalUsageDailyModel(connection),
    conversationThreads: createConversationThreadModel(connection),
    conversationMessages: createConversationMessageModel(connection),
  };
}
