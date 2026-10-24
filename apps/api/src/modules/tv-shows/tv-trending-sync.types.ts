import type { Locale } from '@movie-hub/contract';
import type { SyncLock } from '../movies/movie.types.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';

export interface TvDiagnostics {
  logger: AiLogger;
  verbose: boolean;
}
export interface TvTrendingOptions {
  freshnessMs: number;
}
export interface TvSyncContext {
  locale: Locale;
  page: number;
  generation?: string;
}
export type TvSyncLock = SyncLock;
