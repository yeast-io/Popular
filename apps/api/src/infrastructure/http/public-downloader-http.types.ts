import type { LookupAddress } from 'node:dns';
import type { AiLogger } from '../logging/ai-trace.types.js';

export type DownloaderDnsResolver = (hostname: string) => Promise<LookupAddress[]>;

export interface PublicDownloaderHttpOptions {
  resolve?: DownloaderDnsResolver;
  logger?: AiLogger;
  verbose?: boolean;
}
