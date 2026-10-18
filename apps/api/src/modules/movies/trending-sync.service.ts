import { randomUUID } from 'node:crypto';
import type { Locale } from '@movie-hub/contract';
import type { MovieRecord, SyncLock, TrendingPageRecord, TrendingProvider, TrendingSnapshotRecord, TrendingStore } from './movie.types.js';
import { systemExternalRequestContext } from '../external-usage/external-usage.types.js';

export interface TrendingSyncResult {
  status: 'completed' | 'skipped';
  pages: number;
  movies: number;
}

export type TrendingSyncTrigger = 'manual' | 'load-more' | 'request' | 'scheduler';

export interface TrendingSyncLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

interface SyncContext {
  runId: string;
  trigger: TrendingSyncTrigger;
  scope: 'configured-pages' | 'page';
}

export class TrendingSyncService {
  constructor(
    private readonly provider: TrendingProvider,
    private readonly store: TrendingStore,
    private readonly lock: SyncLock,
    private readonly defaultLocale: Locale,
    private readonly lockTtlSeconds: number,
    private readonly logger: TrendingSyncLogger,
  )
  {
  }

  syncConfiguredPages(pageCount: number, concurrency: number, trigger: TrendingSyncTrigger): Promise<TrendingSyncResult> {
    const locale = this.defaultLocale;
    const context: SyncContext = { runId: randomUUID(), trigger, scope: 'configured-pages' };
    return this.runLogged(context, locale, { requestedPages: pageCount, concurrency }, () => this.withLock(locale, 'all', async () => {
      const snapshot = await this.buildSnapshot(pageCount, concurrency, locale, context);
      await this.store.publishSnapshot(snapshot, locale);
      this.logger.info({
        operation: 'tmdb.trending.publish', ...context, language: locale,
        generation: snapshot.generation, pages: snapshot.pages.length,
      }, 'TMDB trending snapshot published');
      return {
        status: 'completed', pages: snapshot.pages.length,
        movies: snapshot.pages.reduce((sum, page) => sum + page.movies.length, 0),
      };
    }));
  }

  syncPage(page: number, trigger: TrendingSyncTrigger, locale: Locale, generation?: string): Promise<TrendingSyncResult> {
    const context: SyncContext = { runId: randomUUID(), trigger, scope: 'page' };
    return this.runLogged(context, locale, { page }, () => this.withLock(locale,
      `page:${page}:${generation ?? 'new'}`,
      async () => {
        if (!generation) {
          if (page !== 1) throw new Error('A new trending snapshot must start at page 1');
          const snapshot = await this.buildSnapshot(1, 1, locale, context);
          await this.store.publishSnapshot(snapshot, locale);
          return { status: 'completed', pages: 1, movies: snapshot.pages[0]?.movies.length ?? 0 };
        }
        const movies = await this.extendSnapshot(page, locale, generation, context);
        return { status: 'completed', pages: 1, movies };
      },
    ));
  }

  private async fetchPage(page: number, locale: Locale, context: SyncContext) {
    const startedAt = Date.now();
    const fields = { operation: 'tmdb.trending.fetch', ...context, language: locale, page };
    this.logger.info(fields, 'TMDB trending page fetch started');
    try {
      const trigger = context.trigger === 'scheduler' ? 'scheduled_sync'
        : context.trigger === 'request' ? 'api_request'
          : 'manual_refresh';
      const result = await this.provider.fetchPage(page, locale, systemExternalRequestContext(trigger));
      this.logger.info({ ...fields, movies: result.movies.length, durationMs: Date.now() - startedAt }, 'TMDB trending page fetched');
      return result;
    } catch (error) {
      this.logger.info({ ...fields, durationMs: Date.now() - startedAt }, 'TMDB trending page fetch failed; sync failure follows');
      throw error;
    }
  }

  private async buildSnapshot(
    pageCount: number,
    concurrency: number,
    locale: Locale,
    context: SyncContext,
  ): Promise<TrendingSnapshotRecord> {
    const sourceResults: Array<Awaited<ReturnType<TrendingProvider['fetchPage']>>> = [];
    const requestedPages = Array.from({ length: pageCount }, (_, index) => index + 1);
    for (let offset = 0; offset < requestedPages.length; offset += concurrency) {
      sourceResults.push(...await Promise.all(
        requestedPages.slice(offset, offset + concurrency).map((page) => this.fetchPage(page, locale, context)),
      ));
    }
    const first = sourceResults[0];
    const pageSize = Math.max(1, first?.movies.length ?? 20);
    const targetMovieCount = pageCount * pageSize;
    const uniqueMovies: MovieRecord[] = [];
    const seen = new Set<number>();
    for (const result of sourceResults) appendUnique(uniqueMovies, seen, result.movies, targetMovieCount);
    let sourcePage = pageCount;
    let totalPages = sourceResults.reduce((maximum, result) => Math.max(maximum, result.totalPages), pageCount);
    let totalResults = sourceResults.reduce((maximum, result) => Math.max(maximum, result.totalResults), 0);
    while (uniqueMovies.length < targetMovieCount && sourcePage < totalPages) {
      sourcePage += 1;
      const result = await this.fetchPage(sourcePage, locale, context);
      totalPages = Math.max(totalPages, result.totalPages);
      totalResults = Math.max(totalResults, result.totalResults);
      appendUnique(uniqueMovies, seen, result.movies, targetMovieCount);
    }
    const fetchedAt = new Date();
    const pages = requestedPages.map((page): TrendingPageRecord => ({
      movies: uniqueMovies.slice((page - 1) * pageSize, page * pageSize),
      page, totalPages, totalResults, fetchedAt,
    }));
    return { generation: randomUUID(), pages, sourcePage, pageSize, fetchedAt };
  }

  private async extendSnapshot(
    page: number,
    locale: Locale,
    generation: string,
    context: SyncContext,
  ): Promise<number> {
    const snapshot = await this.store.readSnapshot(locale, generation);
    if (!snapshot) throw new Error('Trending snapshot generation is not available');
    if (page !== snapshot.pages.length + 1) throw new Error('Trending snapshot can only be extended by its next page');
    const seen = new Set(snapshot.pages.flatMap(({ movies }) => movies.map(({ tmdbId }) => tmdbId)));
    const movies: MovieRecord[] = [];
    const previous = snapshot.pages.at(-1)!;
    let sourcePage = snapshot.sourcePage;
    let totalPages = previous.totalPages;
    let totalResults = previous.totalResults;
    while (movies.length < snapshot.pageSize && sourcePage < totalPages) {
      sourcePage += 1;
      const result = await this.fetchPage(sourcePage, locale, context);
      totalPages = Math.max(totalPages, result.totalPages);
      totalResults = Math.max(totalResults, result.totalResults);
      appendUnique(movies, seen, result.movies, snapshot.pageSize);
    }
    if (movies.length < snapshot.pageSize) totalPages = page;
    await this.store.appendSnapshotPage({
      movies, page, totalPages, totalResults, fetchedAt: snapshot.fetchedAt,
    }, locale, generation, sourcePage, snapshot.pageSize);
    return movies.length;
  }

  private async withLock(locale: Locale, suffix: string, operation: () => Promise<TrendingSyncResult>): Promise<TrendingSyncResult> {
    const key = `lock:sync:trending:movie:week:${locale}:${suffix}`;
    const owner = await this.lock.acquire(key, this.lockTtlSeconds);
    if (!owner) return { status: 'skipped', pages: 0, movies: 0 };
    try {
      return await operation();
    } finally {
      await this.lock.release(key, owner);
    }
  }

  private async runLogged(
    context: SyncContext,
    locale: Locale,
    details: Record<string, unknown>,
    operation: () => Promise<TrendingSyncResult>,
  ): Promise<TrendingSyncResult> {
    const startedAt = Date.now();
    const fields = { operation: 'tmdb.trending.sync', ...context, language: locale, ...details };
    this.logger.info(fields, 'TMDB trending sync started');
    try {
      const result = await operation();
      const completedFields = { ...fields, ...result, durationMs: Date.now() - startedAt };
      if (result.status === 'skipped') {
        this.logger.info({ ...completedFields, skipReason: 'distributed-lock-held' }, 'TMDB trending sync skipped');
      } else {
        this.logger.info(completedFields, 'TMDB trending sync completed');
      }
      return result;
    } catch (error) {
      this.logger.error({ ...fields, err: error, durationMs: Date.now() - startedAt }, 'TMDB trending sync failed');
      throw error;
    }
  }
}

function appendUnique(target: MovieRecord[], seen: Set<number>, candidates: MovieRecord[], limit: number): void {
  for (const movie of candidates) {
    if (target.length >= limit) return;
    if (seen.has(movie.tmdbId)) continue;
    seen.add(movie.tmdbId);
    target.push(movie);
  }
}
