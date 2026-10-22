import { IntegrationValidationError } from '../../modules/integrations/integration.service.js';

export function parseTorrentUrl(payload: unknown): string {
  const data = payload && typeof payload === 'object' ? (payload as { data?: unknown }).data : undefined;
  let url: URL;
  try {
    if (typeof data !== 'string') throw new Error('Missing torrent URL');
    url = new URL(data);
  } catch (error) {
    throw new IntegrationValidationError('invalid_response', 'M-Team returned an invalid torrent URL', {
      cause: error,
    });
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new IntegrationValidationError('invalid_response', 'M-Team returned an invalid torrent URL');
  }
  return url.href;
}
