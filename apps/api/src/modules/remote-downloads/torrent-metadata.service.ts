import { resourceDownloadLimitKind } from '../resource-sites/resource-download-limit.schema.js';
import { ResourceDownloadLimitError } from '../resource-sites/resource-download-limit.errors.js';
import { serializeDiagnosticError } from '@movie-hub/contract';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { torrentMetadataHash } from './torrent-metadata.schema.js';
import {
  TORRENT_METADATA_MAX_BYTES,
  TORRENT_METADATA_MAX_REDIRECTS,
  TORRENT_METADATA_TIMEOUT_MS,
} from './torrent-metadata.policy.js';
import type { TorrentMetadataOptions } from './torrent-metadata.types.js';

function validateUrl(url: URL): URL {
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new RpcError('INVALID_TORRENT_URL', 'not_applied');
  return url;
}

export async function readTorrentMetadata(url: string, options: TorrentMetadataOptions = {}): Promise<string> {
  const sensitive = new Set([url]);
  const protect = (value: string) => {
    sensitive.add(value);
    currentAiTrace()?.sensitive(value);
  };
  return aiStep('remote-download.torrent-metadata', async () => {
    try {
      protect(url);
      let current = validateUrl(new URL(url));
      const visited = new Set<string>();
      // One budget covers every redirect and the final response stream.
      const signal = AbortSignal.timeout(options.timeoutMs ?? TORRENT_METADATA_TIMEOUT_MS);
      for (let redirects = 0; redirects <= TORRENT_METADATA_MAX_REDIRECTS; redirects++) {
        signal.throwIfAborted();
        if (visited.has(current.href)) throw new RpcError('TORRENT_METADATA_UNAVAILABLE', 'not_applied');
        visited.add(current.href);
        const response = await aiStep('remote-download.torrent-metadata.request', () => {
          return (options.fetch ?? fetch)(current, {
            redirect: 'manual', signal, credentials: 'omit', referrerPolicy: 'no-referrer',
          });
        }, { redirectCount: redirects });
        currentAiTrace()?.event('remote-download.torrent-metadata.response', {
          httpStatus: response.status, redirectCount: redirects,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirects === TORRENT_METADATA_MAX_REDIRECTS)
            throw new RpcError('TORRENT_METADATA_UNAVAILABLE', 'not_applied');
          protect(location);
          const next = new URL(location, current);
          protect(next.href);
          current = validateUrl(next);
          currentAiTrace()?.event('remote-download.torrent-metadata.redirect', {
            httpStatus: response.status, redirectCount: redirects + 1,
          });
          continue;
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new RpcError('TORRENT_METADATA_UNAVAILABLE', 'not_applied');
        }
        if (Number(response.headers.get('content-length')) > TORRENT_METADATA_MAX_BYTES) {
          await response.body.cancel();
          throw new RpcError('TORRENT_METADATA_TOO_LARGE', 'not_applied');
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > TORRENT_METADATA_MAX_BYTES) throw new RpcError('TORRENT_METADATA_TOO_LARGE', 'not_applied');
            chunks.push(next.value);
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            // Preserve the original stream, timeout, or size error if cleanup also fails.
          }
        }
        signal.throwIfAborted();
        const metadata = Buffer.concat(chunks);
        if (options.source && (response.headers.get('content-type')?.includes('json') || metadata[0] === 123)) {
          let payload: unknown;
          try {
            payload = JSON.parse(metadata.toString('utf8'));
          } catch { /* Invalid JSON remains invalid torrent metadata. */ }
          if (resourceDownloadLimitKind(options.source, payload)) throw new ResourceDownloadLimitError();
        }
        return aiStep('remote-download.torrent-metadata.hash', async () => torrentMetadataHash(metadata),
          { responseBytes: size, redirectCount: redirects });
      }
      throw new RpcError('TORRENT_METADATA_UNAVAILABLE', 'not_applied');
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError('TORRENT_METADATA_UNAVAILABLE', 'not_applied', {
        cause: serializeDiagnosticError(error, [...sensitive]),
      });
    }
  });
}
