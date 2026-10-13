import type { ApiError, ErrorCode } from '@movie-hub/contract';
import { t, type TranslationKey } from './index';

const errorKeys = {
  BAD_REQUEST: 'errors.badRequest',
  UNAUTHORIZED: 'errors.unauthorized',
  FORBIDDEN: 'errors.forbidden',
  NOT_FOUND: 'errors.notFound',
  CONFLICT: 'errors.conflict',
  VALIDATION_ERROR: 'errors.validation',
  INTERNAL_ERROR: 'errors.unknown',
  SERVICE_UNAVAILABLE: 'errors.serviceUnavailable',
  TRENDING_NOT_SYNCED: 'errors.trendingNotSynced',
  TRENDING_SYNC_IN_PROGRESS: 'errors.trendingSyncInProgress',
  INTEGRATION_VALIDATION_FAILED: 'errors.mteamValidation',
  MTEAM_NOT_CONFIGURED: 'errors.mteamNotConfigured',
  MTEAM_INVALID_URL: 'errors.mteamInvalidUrl',
  MTEAM_AUTH_FAILED: 'errors.mteamAuthFailed',
  MTEAM_UNREACHABLE: 'errors.mteamUnreachable',
  MTEAM_TIMEOUT: 'errors.mteamTimeout',
  MTEAM_RATE_LIMITED: 'errors.mteamRateLimited',
  MTEAM_UNEXPECTED_RESPONSE: 'errors.mteamUnexpectedResponse',
  MTEAM_MOVIE_UNMATCHABLE: 'errors.mteamMovieUnmatchable',
  MTEAM_CHECK_IN_PROGRESS: 'errors.mteamCheckInProgress',
  MTEAM_SYNC_IN_PROGRESS: 'errors.mteamSyncInProgress',
  MTEAM_SYNC_NOT_FOUND: 'errors.mteamSyncNotFound',
  QBITTORRENT_NOT_CONFIGURED: 'errors.qbittorrentNotConfigured',
  QBITTORRENT_INVALID_URL: 'errors.qbittorrentInvalidUrl',
  QBITTORRENT_AUTH_FAILED: 'errors.qbittorrentAuthFailed',
  QBITTORRENT_UNREACHABLE: 'errors.qbittorrentUnreachable',
  QBITTORRENT_TIMEOUT: 'errors.qbittorrentTimeout',
  QBITTORRENT_UNEXPECTED_RESPONSE: 'errors.qbittorrentUnexpectedResponse',
  MOVIE_DOWNLOAD_FAILED: 'errors.movieDownloadFailed',
} as const satisfies Record<ErrorCode, TranslationKey>;

export class LocalizedApiError extends Error {
  constructor(readonly translationKey: TranslationKey) {
    super(translationKey);
    this.name = 'LocalizedApiError';
  }
}

export function apiErrorKey(value: unknown, fallback: TranslationKey = 'errors.unknown'): TranslationKey {
  const code = (value as Partial<ApiError> | null)?.error?.code;
  return code && code in errorKeys ? errorKeys[code as ErrorCode] : fallback;
}

export function localizedApiError(value: unknown, fallback?: TranslationKey): LocalizedApiError {
  return new LocalizedApiError(apiErrorKey(value, fallback));
}

export async function localizedResponseError(
  response: Response,
  fallback: TranslationKey = 'errors.requestFailed',
): Promise<LocalizedApiError> {
  try {
    return localizedApiError(await response.json(), fallback);
  } catch {
    return new LocalizedApiError(fallback);
  }
}

export function localizedErrorMessage(error: unknown, fallback: TranslationKey): string {
  return t(error instanceof LocalizedApiError ? error.translationKey : fallback);
}
