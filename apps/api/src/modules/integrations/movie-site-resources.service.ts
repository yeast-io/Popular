import {
  MOVIE_SITE_CHECK_LEASE_MS,
  MOVIE_SITE_CHECK_RETRY_MS,
  MOVIE_SITE_QUERY_TIMEOUT_MS,
  MOVIE_SITE_PAGE_TIMEOUT_MS,
  MOVIE_SITE_MAX_PENDING_CHECKS,
} from './movie-site-resources.policy.js';
import type { Locale, MovieResourceCheckResponse, MovieSiteReleaseList } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { ResourceSiteDiagnostics } from '../resource-sites/resource-site.types.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import type { ResourceSiteService } from '../resource-sites/resource-site.service.js';
import type { ResourceSearchService } from '../resource-search/resource-search.service.js';
import type { MovieCatalogStore, MovieSearchProvider } from '../movies/movie.types.js';
import { userExternalRequestContext } from '../external-usage/external-usage.domain.js';
import type { MovieResourceCheckService } from './movie-resource-check.service.js';
import type {
  MovieResourceCheckCompletion,
  MovieResourceCheckExecution,
  MovieResourceCheckRecord,
  MovieResourceCheckStore,
} from './movie-resource-check.types.js';
import type { IntegrationPreferencesService } from './integration-preferences.service.js';
import type { MovieSiteReleaseCache } from './movie-site-resources.types.js';
import { aggregateSiteChecks, completionForSiteCheck, siteCheckResponse } from './movie-site-resources.domain.js';

export class MovieSiteResourcesService {
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly cache = new Map<string, MovieSiteReleaseCache>();
  private readonly requests = new Map<string, Promise<MovieSiteReleaseList>>();
  private stopped = false;
  private readonly siteQueues = new Map<string, Promise<void>>();
  private readonly pendingChecks = new Map<string, Promise<void>>();

  constructor(
    private readonly checks: MovieResourceCheckStore,
    private readonly mteam: Pick<MovieResourceCheckService, 'request' | 'checkNowDetailed' | 'listReleases'>,
    private readonly preferences: Pick<IntegrationPreferencesService, 'get'>,
    private readonly search: Pick<ResourceSearchService, 'search'>,
    private readonly sites: Pick<ResourceSiteService, 'registry' | 'configuration' | 'cacheVersion'>,
    private readonly movies: Pick<MovieCatalogStore, 'hasMovie' | 'readMovieIdentity' | 'writeMovieDetail'>,
    private readonly tmdb: Pick<MovieSearchProvider, 'fetchDetails'>,
    private readonly locale: Locale,
    private readonly diagnostics: ResourceSiteDiagnostics,
    private readonly ttlMs: number
  ) {}

  async selectedSites(ownerId: string): Promise<string[]> {
    return (await this.preferences.get(ownerId)).effectiveSites;
  }

  async summary(ownerId: string, tmdbId: number, selected?: string[]): Promise<MovieResourceCheckResponse> {
    const ids = selected ?? (await this.selectedSites(ownerId));
    return aggregateSiteChecks(
      await Promise.all(
        ids.map(async (site) => {
          return this.displayCheck(
            ownerId,
            tmdbId,
            site,
            await this.checks.readOne({ ownerId, tmdbId, provider: site })
          );
        })
      )
    );
  }

  async summaries(ownerId: string, tmdbIds: number[]): Promise<Map<number, MovieResourceCheckResponse>> {
    const ids = await this.selectedSites(ownerId);
    const rows = await this.checks.readForMovies(ownerId, tmdbIds);
    return new Map(
      tmdbIds.map((tmdbId) => {
        return [
          tmdbId,
          aggregateSiteChecks(
            ids.map((site) => {
              return this.displayCheck(
                ownerId,
                tmdbId,
                site,
                rows.find((row) => row.tmdbId === tmdbId && row.provider === site)
              );
            })
          ),
        ];
      })
    );
  }

  private displayCheck(
    ownerId: string,
    tmdbId: number,
    site: string,
    row?: MovieResourceCheckRecord | null
  ): MovieResourceCheckResponse {
    const response = siteCheckResponse(site, row);
    return this.pendingChecks.has(JSON.stringify([ownerId, tmdbId, site])) ? { ...response, checking: true } : response;
  }

  private queueSite(ownerId: string, tmdbId: number, site: string, force: boolean): void {
    const key = JSON.stringify([ownerId, tmdbId, site]);
    if (this.pendingChecks.has(key)) return;
    if (this.pendingChecks.size >= MOVIE_SITE_MAX_PENDING_CHECKS) throw new ResourceSiteError('rateLimited');
    const previous = this.siteQueues.get(site) ?? Promise.resolve();
    const task = previous
      .then(() => {
        return this.trace(ownerId, tmdbId, async () => {
          const attemptedAt = new Date();
          const config = await this.sites.configuration(ownerId, site);
          const identity = await this.movies.readMovieIdentity?.(tmdbId, this.locale);
          const fingerprint = identity ? JSON.stringify([identity.title, identity.imdbId ?? null]) : undefined;
          const acquired = await this.checks.tryAcquire(
            { ownerId, tmdbId, provider: site },
            attemptedAt,
            new Date(attemptedAt.getTime() + MOVIE_SITE_CHECK_LEASE_MS),
            new Date(attemptedAt.getTime() - MOVIE_SITE_CHECK_RETRY_MS),
            fingerprint,
            config.verifiedAt ? new Date(config.verifiedAt) : undefined,
            force
          );
          if (!acquired) return;
          const result = await this.executeSite(ownerId, tmdbId, site);
          await this.checks.complete({ ownerId, tmdbId, provider: site }, attemptedAt, result);
        });
      })
      .catch((error) => {
        this.diagnostics.logger.error({ err: error, ownerId, tmdbId, site }, 'Resource check persistence failed');
      })
      .finally(() => {
        this.pendingChecks.delete(key);
        this.tasks.delete(task);
        if (this.siteQueues.get(site) === task) this.siteQueues.delete(site);
      });
    this.pendingChecks.set(key, task);
    this.siteQueues.set(site, task);
    this.tasks.add(task);
  }

  schedule(ownerId: string, tmdbId: number, options: { force?: boolean } = {}): void {
    if (this.stopped) return;
    const task = this.trace(ownerId, tmdbId, () => this.request(ownerId, tmdbId, options.force ?? false))
      .catch((error) => {
        return this.diagnostics.logger.error({ err: error, ownerId, tmdbId }, 'Could not schedule resource checks');
      })
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  async request(ownerId: string, tmdbId: number, force = true): Promise<boolean> {
    if (this.stopped) return false;
    const ids = await this.selectedSites(ownerId);
    if (!ids.length) throw new ResourceSiteError('notConfigured');
    if (!(await this.movies.hasMovie(tmdbId))) throw new AppError(404, 'NOT_FOUND', '');
    for (const site of ids) {
      try {
        if (site === 'mteam') await this.mteam.request(ownerId, tmdbId, force);
        else this.queueSite(ownerId, tmdbId, site, force);
      } catch (error) {
        currentAiTrace()?.fail(error, { stage: 'movie-resources.site.enqueue', site });
        currentAiTrace()?.clearFailure();
        await this.checks.recordAttempt({ ownerId, tmdbId, provider: site }, new Date(), this.failureResult(error));
      }
    }
    return ids.length > 0;
  }

  async checkNowDetailed(
    ownerId: string,
    tmdbId: number,
    force = false,
    selected?: string[]
  ): Promise<MovieResourceCheckExecution> {
    const ids = selected ?? (await this.selectedSites(ownerId));
    const results = await Promise.all(
      ids
        .map(async (site) => {
          if (site === 'mteam') {
            const execution = await this.mteam.checkNowDetailed(ownerId, tmdbId, force);
            if (execution.started) return execution.result;
          } else {
            const attemptedAt = new Date();
            const config = await this.sites.configuration(ownerId, site);
            if (
              await this.checks.tryAcquire(
                { ownerId, tmdbId, provider: site },
                attemptedAt,
                new Date(attemptedAt.getTime() + MOVIE_SITE_CHECK_LEASE_MS),
                new Date(attemptedAt.getTime() - MOVIE_SITE_CHECK_RETRY_MS),
                undefined,
                config.verifiedAt ? new Date(config.verifiedAt) : undefined,
                force
              )
            ) {
              const result = await this.trace(ownerId, tmdbId, () => this.executeSite(ownerId, tmdbId, site));
              await this.checks.complete({ ownerId, tmdbId, provider: site }, attemptedAt, result);
              return result;
            }
          }
          const deadline = Date.now() + MOVIE_SITE_CHECK_LEASE_MS;
          let row = await this.checks.readOne({ ownerId, tmdbId, provider: site });
          while (row?.checking && !this.stopped && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            row = await this.checks.readOne({ ownerId, tmdbId, provider: site });
          }
          return completionForSiteCheck(row);
        })
        .map((operation) => {
          return operation.catch((error) => {
            currentAiTrace()?.fail(error, { stage: 'movie-resources.batch.site' });
            currentAiTrace()?.clearFailure();
            return this.failureResult(error);
          });
        })
    );
    const successful = results.filter((result) => result.lastAttemptStatus === 'success');
    const available = successful.find((result) => result.availability === 'available');
    const result = available
      ?? results.find((item) => {
        return item.lastAttemptStatus === 'error';
      })
      ?? successful.find((item) => {
        return item.availability === 'unmatchable';
      })
      ?? successful[0] ?? { lastAttemptStatus: 'error' as const, lastErrorCode: 'internal_error' as const };
    return { started: true, result };
  }

  private async executeSite(ownerId: string, tmdbId: number, site: string): Promise<MovieResourceCheckCompletion> {
    try {
      const result = await this.listReleases(ownerId, tmdbId, site, 1, true);
      const checkedAt = new Date(result.queriedAt);
      if (result.availability === 'unmatchable') {
        const identity = await this.movies.readMovieIdentity?.(tmdbId, this.locale);
        return {
          lastAttemptStatus: 'success',
          availability: 'unmatchable',
          checkedAt,
          identityFingerprint: JSON.stringify([identity?.title ?? '', identity?.imdbId ?? null]),
        };
      }
      return {
        lastAttemptStatus: 'success',
        availability: result.availability === 'available' ? 'available' : 'unavailable',
        checkedAt,
        expiresAt: new Date(checkedAt.getTime() + this.ttlMs),
        matchedBy: 'imdb',
      };
    } catch (error) {
      currentAiTrace()?.fail(error, { stage: 'movie-resources.site.check', site });
      currentAiTrace()?.clearFailure();
      return this.failureResult(error);
    }
  }

  private failureResult(error: unknown): Extract<MovieResourceCheckCompletion, { lastAttemptStatus: 'error' }> {
    const reason = error instanceof ResourceSiteError ? error.reason : undefined;
    return {
      lastAttemptStatus: 'error',
      lastErrorCode:
        reason && ['authentication', 'notConfigured', 'blocked'].includes(reason)
          ? 'authentication'
          : reason === 'rateLimited'
            ? 'rate_limited'
            : reason === 'timeout'
              ? 'timeout'
              : 'remote_error',
    };
  }

  async listReleases(
    ownerId: string,
    tmdbId: number,
    site: string,
    page = 1,
    force = false
  ): Promise<MovieSiteReleaseList> {
    const attemptedAt = new Date();
    try {
      return await this.queryReleases(ownerId, tmdbId, site, page, force);
    } catch (error) {
      if (site !== 'mteam' && this.sites.registry.has(site)) {
        try {
          await this.checks.recordAttempt({ ownerId, tmdbId, provider: site }, attemptedAt, this.failureResult(error));
        } catch (recordError) {
          currentAiTrace()?.fail(recordError, { stage: 'movie-resources.failure.persist', site });
        }
      }
      throw error;
    }
  }

  async releaseForDownload(
    ownerId: string,
    tmdbId: number,
    site: string,
    releaseId: string
  ): Promise<MovieSiteReleaseList['releases'][number]> {
    const deadline = Date.now() + MOVIE_SITE_QUERY_TIMEOUT_MS;
    let page: number | undefined = 1;
    while (page !== undefined) {
      if (Date.now() >= deadline) throw new ResourceSiteError('timeout');
      const result = await this.listReleases(ownerId, tmdbId, site, page);
      const release = result.releases.find((item) => item.id === releaseId);
      if (release) return release;
      page = result.nextPage;
    }
    throw new AppError(404, 'NOT_FOUND', '');
  }

  private async queryReleases(
    ownerId: string,
    tmdbId: number,
    site: string,
    page: number,
    force: boolean
  ): Promise<MovieSiteReleaseList> {
    if (!(await this.movies.hasMovie(tmdbId))) throw new AppError(404, 'NOT_FOUND', '');
    if (site === 'mteam') {
      const result = await this.mteam.listReleases(ownerId, tmdbId, { force });
      return { ...result, site, name: 'M-Team', supportsDownload: true };
    }
    const adapter = this.sites.registry.get(site);
    if (!adapter) throw new AppError(404, 'NOT_FOUND', '');
    const configuration = await this.sites.configuration(ownerId, site);
    if (configuration.status !== 'configured_valid') throw new ResourceSiteError('authentication');
    let identity = await aiStep('movie-resources.identity', async () => {
      return this.movies.readMovieIdentity?.(tmdbId, this.locale);
    });
    if (!identity?.imdbId) {
      const detail = await aiStep('movie-resources.identity.refresh', () => {
        return this.tmdb.fetchDetails(tmdbId, this.locale, userExternalRequestContext(ownerId, 'background_check'));
      });
      await this.movies.writeMovieDetail(detail, new Date(), this.locale);
      identity = detail;
    }
    const key = JSON.stringify([
      ownerId,
      tmdbId,
      site,
      page,
      identity.imdbId,
      await this.sites.cacheVersion(ownerId, site),
    ]);
    for (const [id, entry] of this.cache) if (entry.expiresAt <= Date.now()) this.cache.delete(id);
    const cached = this.cache.get(key);
    if (!force && cached) return { ...cached.value, cached: true };
    const pending = this.requests.get(key);
    if (pending) return pending;
    const operation = (async (): Promise<MovieSiteReleaseList> => {
      const attemptedAt = new Date();
      let releases: MovieSiteReleaseList['releases'] = [];
      let nextPage: number | undefined;
      if (identity?.imdbId) {
        const deadline = AbortSignal.timeout(MOVIE_SITE_QUERY_TIMEOUT_MS);
        let currentPage = page;
        do {
          const result = await aiStep(
            'movie-resources.site.search',
            () => {
              return this.search.search(
                ownerId,
                site,
                { imdbId: identity!.imdbId!, page: currentPage },
                AbortSignal.any([deadline, AbortSignal.timeout(MOVIE_SITE_PAGE_TIMEOUT_MS)])
              );
            },
            { site, page: currentPage }
          );
          releases = result.releases
            .filter((release) => {
              return (
                (!release.imdbId || release.imdbId === identity!.imdbId)
                && (release.seeders === undefined || release.seeders > 0)
              );
            })
            .map((release) => {
              return {
                ...release,
                seeders: release.seeders ?? 0,
                seedersKnown: release.seeders !== undefined,
                tags: release.tags ?? [],
                detailsUrl: adapter.detailsUrl?.(release.id) ?? adapter.baseUrl,
              };
            });
          nextPage = result.nextPage;
          if (nextPage !== undefined && (nextPage <= currentPage || nextPage > 100))
            throw new ResourceSiteError('invalidResponse');
          if (releases.length || !nextPage) break;
          if (this.stopped) throw new ResourceSiteError('timeout');
          currentPage = nextPage;
        } while (!this.stopped);
      }
      const queriedAt = new Date();
      const availability = !identity?.imdbId
        ? ('unmatchable' as const)
        : releases.length
          ? ('available' as const)
          : ('unavailable' as const);
      const value: MovieSiteReleaseList = {
        site,
        name: adapter.name,
        supportsDownload: Boolean(adapter.torrentUrl),
        queriedAt: queriedAt.toISOString(),
        cached: false,
        availability,
        releases,
        ...(nextPage ? { nextPage } : {}),
      };
      // Later pages must not overwrite the whole movie's positive availability with a page-local empty result.
      if (page === 1)
        await this.checks.recordAttempt(
          { ownerId, tmdbId, provider: site },
          attemptedAt,
          availability === 'unmatchable'
            ? {
                lastAttemptStatus: 'success',
                availability,
                checkedAt: queriedAt,
                identityFingerprint: JSON.stringify([identity?.title ?? '', null]),
              }
            : {
                lastAttemptStatus: 'success',
                availability,
                checkedAt: queriedAt,
                expiresAt: new Date(queriedAt.getTime() + this.ttlMs),
                matchedBy: 'imdb',
              }
        );
      this.cache.set(key, { expiresAt: Date.now() + this.ttlMs, value });
      return value;
    })().finally(() => this.requests.delete(key));
    this.requests.set(key, operation);
    return operation;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    while (this.tasks.size || this.requests.size) await Promise.allSettled([...this.tasks, ...this.requests.values()]);
    this.cache.clear();
  }

  private trace<T>(ownerId: string, tmdbId: number, action: () => Promise<T>): Promise<T> {
    const trace
      = currentAiTrace()
        ?? new AiTrace(this.diagnostics.logger, { ownerId, tmdbId }, '', 'movie-resources', this.diagnostics.verbose);
    return withAiTrace(trace, () => aiStep('movie-resources.check', action));
  }
}
