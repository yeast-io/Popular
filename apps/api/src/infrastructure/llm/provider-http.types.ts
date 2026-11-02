import type { AiProvider } from '@movie-hub/contract';

export interface ProviderHttpOptions {
  provider: AiProvider;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}
export interface ProviderStreamEvent { type: string; [key: string]: unknown }
