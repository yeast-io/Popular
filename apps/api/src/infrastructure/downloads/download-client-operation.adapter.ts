import type { DownloadProvider, Locale } from '@movie-hub/contract';
import { aiStep } from '../logging/ai-trace.js';
import { downloadClientError } from '../../modules/downloads/download-client.errors.js';

export async function downloadClientOperation<T>(
  provider: DownloadProvider, operation: string, locale: Locale, action: () => Promise<T>
): Promise<T> {
  return aiStep(`download.client.${operation}`, async () => {
    try {
      return await action();
    } catch (error) {
      throw downloadClientError(provider, error, locale);
    }
  }, { provider });
}
