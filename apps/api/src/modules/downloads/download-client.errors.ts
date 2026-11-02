import type { DownloadProvider, Locale } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { qbittorrentAppError } from '../integrations/qbittorrent-integration.service.js';
import { transmissionAppError } from '../integrations/transmission-integration.service.js';
import { downloadClientMessages } from './download-client.messages.js';

export function downloadClientError(provider: DownloadProvider, error: unknown, locale: Locale = 'en-US'): AppError {
  if (error instanceof AppError) return error;
  const message = downloadClientMessages[locale].accessFailed[provider];
  const mapped = provider === 'transmission'
    ? transmissionAppError(error, message)
    : qbittorrentAppError(error, message);
  mapped.cause ??= error;
  return mapped;
}
