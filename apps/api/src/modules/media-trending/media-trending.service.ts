import { randomUUID } from 'node:crypto';
import type { Locale } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { userExternalRequestContext } from '../external-usage/external-usage.domain.js';
import { mediaTrendingPolicy } from './media-trending.policy.js';
import { mediaTrendingMessages } from './media-trending.presentation.js';
import type { MediaTrendingSnapshot } from './media-trending.schema.js';
import type { MediaTrendingItem, MediaTrendingKind, MediaTrendingLock, MediaTrendingOptions, MediaTrendingReader, MediaTrendingResult, MediaTrendingSource, MediaTrendingStore } from './media-trending.types.js';

export class MediaTrendingService<T extends MediaTrendingItem> implements MediaTrendingReader<T> {
  constructor(
    private readonly media: MediaTrendingKind,
    private readonly store: MediaTrendingStore,
    private readonly source: MediaTrendingSource<T>,
    private readonly lock: MediaTrendingLock,
    private readonly options: MediaTrendingOptions
  ) {}

  async page(page: number, locale: Locale, ownerId: string | null, generation?: string): Promise<MediaTrendingResult<T>> {
    const trace = currentAiTrace() ?? new AiTrace(this.options.logger, { media: this.media, locale }, '', 'media.trending', this.options.verbose ?? false);
    return withAiTrace(trace, async () => {
      try {
        const result = await trace.step('media.trending', () => this.load(page, locale, ownerId, generation), { media: this.media, locale, page });
        trace.event('media.trending.result', { outcome: 'success', generation: result.generation, page });
        return result;
      } catch (error) {
        trace.fail(error, { outcome: 'failure', media: this.media, page, locale });
        if (error instanceof AppError) throw error;
        throw new AppError(503, 'SERVICE_UNAVAILABLE', mediaTrendingMessages(locale).unavailable, undefined, { cause: error });
      }
    });
  }

  private expired(locale: Locale): never {
    throw new AppError(409, 'MEDIA_TRENDING_EXPIRED', mediaTrendingMessages(locale).expired);
  }

  private async cached(locale: Locale): Promise<MediaTrendingSnapshot | null> {
    const snapshot = await aiStep('media.trending.cache.read', () => this.store.read(this.media, locale));
    const record = snapshot && snapshot.expiresAt > Date.now() ? snapshot : null;
    currentAiTrace()?.event('media.trending.cache.result', { outcome: record ? 'hit' : 'miss', media: this.media, locale });
    return record;
  }

  private validate(snapshot: MediaTrendingSnapshot | null, page: number, locale: Locale, generation?: string): void {
    if (page < 1 || page > mediaTrendingPolicy.maxPage || (page > 1 && !generation)) this.expired(locale);
    if (generation && (!snapshot || snapshot.generation !== generation)) this.expired(locale);
    if (page > 1 && !snapshot?.pages[page - 2]) this.expired(locale);
    if (snapshot && page > Math.min(snapshot.totalPages, mediaTrendingPolicy.maxPage) && page > 1)
      throw new AppError(400, 'BAD_REQUEST', mediaTrendingMessages(locale).noMore);
  }

  private async load(page: number, locale: Locale, ownerId: string | null, generation?: string): Promise<MediaTrendingResult<T>> {
    let snapshot = await this.cached(locale);
    this.validate(snapshot, page, locale, generation);
    if (snapshot?.pages[page - 1]) return this.result(snapshot, page, locale);
    const key = `lock:media-trending:${this.media}:week:${locale}`;
    const owner = await aiStep('media.trending.lock.acquire', () => this.lock.acquire(key, mediaTrendingPolicy.lockTtlSeconds));
    if (!owner) throw new AppError(409, 'CONFLICT', mediaTrendingMessages(locale).busy);
    let failure: unknown;
    try {
      snapshot = await this.cached(locale);
      this.validate(snapshot, page, locale, generation);
      if (snapshot?.pages[page - 1]) return await this.result(snapshot, page, locale);
      const ids = new Set([...(snapshot?.pages.flat() ?? []), ...(snapshot?.pendingIds ?? [])]);
      const collectedIds = [...(snapshot?.pendingIds ?? [])];
      let sourcePage = snapshot?.sourcePage ?? 0;
      let totalPages = snapshot?.totalPages ?? 1;
      let totalResults = snapshot?.totalResults ?? 0;
      let pageSize = snapshot?.pageSize ?? 0;
      // Refill overlapping pages while preserving source order and bounded provider pagination.
      while (!pageSize || (collectedIds.length < pageSize && sourcePage < Math.min(totalPages, mediaTrendingPolicy.maxPage))) {
        const fetched = await aiStep('media.trending.tmdb.fetch', () => this.source.fetch(++sourcePage, locale, userExternalRequestContext(ownerId, 'api_request')), { sourcePage: sourcePage + 1, media: this.media, locale });
        totalPages = fetched.totalPages;
        totalResults = fetched.totalResults;
        pageSize ||= Math.max(1, fetched.items.length);
        await aiStep('media.trending.catalog.save', () => this.source.save(fetched.items, locale, new Date()));
        for (const item of fetched.items) {
          if (ids.has(item.tmdbId)) continue;
          ids.add(item.tmdbId);
          collectedIds.push(item.tmdbId);
        }
      }
      // Keep overflow IDs: filling a deduplicated page must not drop the next source page's tail.
      const pages = snapshot?.pages.map((ids) => [...ids]) ?? [];
      pages.push(collectedIds.slice(0, pageSize));
      const now = Date.now();
      snapshot = { generation: snapshot?.generation ?? randomUUID(), fetchedAt: snapshot?.fetchedAt ?? new Date(now).toISOString(),
        expiresAt: snapshot?.expiresAt ?? now + this.options.ttlSeconds * 1000,
        sourcePage, totalPages, totalResults, pageSize, pages, pendingIds: collectedIds.slice(pageSize) };
      if (snapshot.expiresAt <= Date.now()) this.expired(locale);
      await aiStep('media.trending.cache.publish', () => this.store.write(this.media, locale, snapshot!, { key, owner }));
      return await this.result(snapshot, page, locale);
    } catch (error) {
      failure = error;
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'SERVICE_UNAVAILABLE', mediaTrendingMessages(locale).unavailable, undefined, { cause: error });
    } finally {
      await this.release(key, owner, failure);
    }
  }

  private async release(key: string, owner: string, failure: unknown): Promise<void> {
    try {
      await aiStep('media.trending.lock.release', () => this.lock.release(key, owner));
    } catch (error) {
      if (!failure) throw error;
      currentAiTrace()?.fail(error, { stage: 'media.trending.lock.release', outcome: 'failure' });
    }
  }

  private async result(snapshot: MediaTrendingSnapshot, page: number, locale: Locale): Promise<MediaTrendingResult<T>> {
    const ids = snapshot.pages[page - 1]!;
    const records = await aiStep('media.trending.catalog.read', () => this.source.read(ids, locale));
    const byId = new Map(records.map((record) => [record.tmdbId, record]));
    const items = ids.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
    if (items.length !== ids.length) throw new AppError(503, 'SERVICE_UNAVAILABLE', mediaTrendingMessages(locale).unavailable);
    return { items, page, totalPages: snapshot.totalPages, totalResults: snapshot.totalResults,
      generation: snapshot.generation, fetchedAt: snapshot.fetchedAt,
      hasMore: page < mediaTrendingPolicy.maxPage && (page < snapshot.pages.length || snapshot.pendingIds.length > 0 || snapshot.sourcePage < Math.min(snapshot.totalPages, mediaTrendingPolicy.maxPage)) };
  }
}
