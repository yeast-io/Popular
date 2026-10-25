import type { Locale } from '@movie-hub/contract';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import type { ExternalRequestContext } from '../external-usage/external-usage.types.js';
import type { MediaTrendingSnapshot } from './media-trending.schema.js';

export type MediaTrendingKind = 'movie' | 'tv';
export interface MediaTrendingItem { tmdbId: number }
export interface MediaTrendingPage<T> {
  items: T[];
  page: number;
  totalPages: number;
  totalResults: number;
}
export interface MediaTrendingResult<T> extends MediaTrendingPage<T> {
  generation: string;
  fetchedAt: string;
  hasMore: boolean;
}
export interface MediaTrendingSource<T> {
  fetch(page: number, locale: Locale, context: ExternalRequestContext): Promise<MediaTrendingPage<T>>;
  save(items: T[], locale: Locale, now: Date): Promise<void>;
  read(ids: number[], locale: Locale): Promise<T[]>;
}
export interface MediaTrendingLease { key: string; owner: string }
export interface MediaTrendingStore {
  read(media: MediaTrendingKind, locale: Locale): Promise<MediaTrendingSnapshot | null>;
  write(media: MediaTrendingKind, locale: Locale, snapshot: MediaTrendingSnapshot, lease: MediaTrendingLease): Promise<void>;
}
export interface MediaTrendingLock {
  acquire(key: string, ttlSeconds: number): Promise<string | null>;
  release(key: string, owner: string): Promise<void>;
}
export interface MediaTrendingOptions {
  ttlSeconds: number;
  logger?: AiLogger;
  verbose?: boolean;
}
export interface MediaTrendingReader<T> {
  page(page: number, locale: Locale, ownerId: string | null, generation?: string): Promise<MediaTrendingResult<T>>;
}
