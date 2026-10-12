import { randomUUID } from 'node:crypto';
import type { Locale } from '@movie-hub/contract';
import type { SyncLock, TrendingProvider, TrendingStore } from './movie.types.js';

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
  ) {}

  syncConfiguredPages(pageCount: number, concurrency: number, trigger: TrendingSyncTrigger): Promise<TrendingSyncResult> {
    const locale = this.defaultLocale;
    const context: SyncContext = { runId: randomUUID(), trigger, scope: 'configured-pages' };
    return this.runLogged(context, locale, { requestedPages: pageCount, concurrency }, () => this.withLock(locale, 'all', async () => {
      const pages = Array.from({ length: pageCount }, (_, index) => index + 1);
      let movieCount = 0;
      for (let offset = 0; offset < pages.length; offset += concurrency) {
        const batch = await Promise.all(pages.slice(offset, offset + concurrency).map((page) => this.fetchAndPublish(page, locale, context)));
        movieCount += batch.reduce((sum, count) => sum + count, 0);
      }
      return { status: 'completed', pages: pageCount, movies: movieCount };
    }));
  }

  syncPage(page: number, trigger: TrendingSyncTrigger, locale: Locale): Promise<TrendingSyncResult> {
    const context: SyncContext = { runId: randomUUID(), trigger, scope: 'page' };
    return this.runLogged(context, locale, { page }, () => this.withLock(locale,
      `page:${page}`,
      async () => ({ status: 'completed', pages: 1, movies: await this.fetchAndPublish(page, locale, context) }),
    ));
  }

  private async fetchAndPublish(page: number, locale: Locale, context: SyncContext): Promise<number> {
    const startedAt = Date.now();
    const fields = { operation: 'tmdb.trending.fetch', ...context, language: locale, page };
    this.logger.info(fields, 'TMDB trending page fetch started');
    try {
      const result = await this.provider.fetchPage(page, locale);
      await this.store.publishPage({ ...result, fetchedAt: new Date() }, locale);
      this.logger.info({ ...fields, movies: result.movies.length, durationMs: Date.now() - startedAt }, 'TMDB trending page fetched and published');
      return result.movies.length;
    } catch (error) {
      this.logger.info({ ...fields, durationMs: Date.now() - startedAt }, 'TMDB trending page fetch failed; sync failure follows');
      throw error;
    }
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
