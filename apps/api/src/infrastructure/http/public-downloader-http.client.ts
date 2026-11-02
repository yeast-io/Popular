import dns from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { isPublicDownloaderAddress, isPublicDownloaderIp } from '../../modules/integrations/public-downloader-address.domain.js';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../logging/ai-trace.js';
import { DownloaderAddressError } from './public-downloader-http.errors.js';
import type { DownloaderDnsResolver, PublicDownloaderHttpOptions } from './public-downloader-http.types.js';

/** Runs inside TCP/TLS lookup: the validated addresses are the ones the socket uses. */
export function createPublicDownloaderLookup(
  resolve: DownloaderDnsResolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true })
): LookupFunction {
  return (hostname, options, callback) => {
    void aiStep('downloader.dns.resolve', async () => {
      const addresses = await resolve(hostname);
      if (!addresses.length || addresses.some((entry) =>
        isIP(entry.address) !== entry.family || !isPublicDownloaderIp(entry.address)
      )) throw new DownloaderAddressError();
      const family = Number(options.family) || 0;
      const candidates = addresses.filter((entry) => !family || entry.family === family);
      if (!candidates.length) throw new DownloaderAddressError();
      return candidates;
    }).then(
      (addresses) => options.all
        ? callback(null, addresses)
        : callback(null, addresses[0]!.address, addresses[0]!.family),
      (error: NodeJS.ErrnoException) => callback(error, '')
    );
  };
}

export class PublicDownloaderHttpClient {
  private readonly dispatcher: Agent;

  constructor(private readonly options: PublicDownloaderHttpOptions = {}) {
    // A dedicated direct Agent deliberately ignores global/environment proxy dispatchers.
    // A remote proxy could resolve an approved hostname to a private destination itself.
    this.dispatcher = new Agent({ connect: { lookup: createPublicDownloaderLookup(options.resolve) }, autoSelectFamily: true });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const parent = currentAiTrace();
    const trace = this.options.logger
      ? new AiTrace(this.options.logger, { correlationId: parent?.correlationId }, '', 'downloader.http', this.options.verbose ?? false)
      : parent;
    const request = async () => {
      try {
        return await aiStep('downloader.http.request', async () => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
            || !isPublicDownloaderAddress(url)) throw new DownloaderAddressError();
          // Keep the URL hostname intact: Host, TLS SNI and certificate validation use it.
          return fetch(input, {
            ...init,
            // Node's bundled Undici declarations differ from the package version;
            // native fetch accepts its compatible Dispatcher runtime contract.
            dispatcher: this.dispatcher as unknown as NonNullable<RequestInit['dispatcher']>,
            redirect: 'error',
          });
        });
      } catch (error) {
        trace?.fail(error);
        throw error;
      }
    };
    return trace ? withAiTrace(trace, request) : request();
  };

  async close(): Promise<void> {
    await this.dispatcher.destroy();
  }
}

const directDownloaderHttp = new PublicDownloaderHttpClient();
export const publicDownloaderFetch: typeof fetch = directDownloaderHttp.fetch;
