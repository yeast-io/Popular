import type { TvPreferenceService } from '../tv-preferences/tv-preference.service.js';
import type { FastifyInstance } from 'fastify';
import { TvShowParamsSchema, TvLocaleQuerySchema, TvShowDetailSchema, TvSeasonParamsSchema, TvSeasonDetailSchema, TvTrendingQuerySchema, TvTrendingResponseSchema, TvSearchQuerySchema, TvSearchResponseSchema } from '@movie-hub/contract';
import type { TvShowParams, TvLocaleQuery, TvSeasonParams, TvTrendingQuery, TvSearchQuery, Locale } from '@movie-hub/contract';
import type { AppConfig } from '../../config/env.schema.js';
import type { AuthService } from '../auth/auth.service.js';
import { readSessionToken } from '../auth/auth.routes.js';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { TvShowService } from './tv-show.service.js';
import type { TvSeasonService } from './tv-season.service.js';
import type { TvTrendingSyncService } from './tv-trending-sync.service.js';
import type { TvDiagnostics } from './tv-trending-sync.types.js';

export function registerTvShowRoutes(app: FastifyInstance, shows: TvShowService, seasons: TvSeasonService, trending: TvTrendingSyncService, config: AppConfig, diagnostics: TvDiagnostics, auth?: AuthService, preferences?: TvPreferenceService): void {
  async function run<T>(requestId: string, locale: Locale, operation: string, action: () => Promise<T>): Promise<T> {
    const trace = new AiTrace(diagnostics.logger, { requestId, correlationId: requestId, locale }, '', operation, diagnostics.verbose);
    return withAiTrace(trace, async () => {
      try {
        const result = await trace.step(operation, action);
        trace.event(`${operation}.result`, { outcome: 'success' });
        return result;
      } catch (error) {
        trace.fail(error, { outcome: 'failure' });
        throw error;
      }
    });
  }
  const ownerId = async (cookie: string | undefined) => auth ? auth.optionalOwnerId(cookie) : null;
  app.get<{
    Querystring: TvTrendingQuery;
  }>('/tv-shows/trending', {
    schema: { querystring: TvTrendingQuerySchema, response: { 200: TvTrendingResponseSchema } },
  }, async (request, reply) => {
    const locale = request.query.locale ?? config.TMDB_LANGUAGE;
    reply.header('cache-control', 'private, no-store');
    return run(request.id, locale, 'tv.trending', async () => {
      const owner = await ownerId(readSessionToken(request, config.SESSION_COOKIE_NAME));
      const result = await trending.trending(request.query.page ?? 1, locale, owner, request.query.generation);
      return { ...result, items: preferences ? await preferences.apply(owner, result.items) : result.items };
    });
  });
  app.get<{ Querystring: TvSearchQuery }>('/tv-shows/search', {
    schema: { querystring: TvSearchQuerySchema, response: { 200: TvSearchResponseSchema } },
  }, async (request, reply) => {
    const locale = request.query.locale ?? config.TMDB_LANGUAGE;
    reply.header('cache-control', 'private, no-store');
    return run(request.id, locale, 'tv.search', async () => {
      const owner = await ownerId(readSessionToken(request, config.SESSION_COOKIE_NAME));
      const result = await shows.search(request.query.query, request.query.page ?? 1, locale, owner);
      return { ...result, items: preferences ? await preferences.apply(owner, result.items) : result.items };
    });
  });
  app.get<{
    Params: TvShowParams;
    Querystring: TvLocaleQuery;
  }>('/tv-shows/:tmdbId', {
    schema: { params: TvShowParamsSchema, querystring: TvLocaleQuerySchema, response: { 200: TvShowDetailSchema } },
  }, async (request) => {
    const locale = request.query.locale ?? config.TMDB_LANGUAGE;
    return run(request.id, locale, 'tv.detail', async () => shows.detail(request.params.tmdbId, locale, await ownerId(readSessionToken(request, config.SESSION_COOKIE_NAME))));
  });
  app.get<{
    Params: TvSeasonParams;
    Querystring: TvLocaleQuery;
  }>('/tv-shows/:tmdbId/seasons/:seasonNumber', {
    schema: { params: TvSeasonParamsSchema, querystring: TvLocaleQuerySchema, response: { 200: TvSeasonDetailSchema } },
  }, async (request) => {
    const locale = request.query.locale ?? config.TMDB_LANGUAGE;
    return run(request.id, locale, 'tv.season', async () => seasons.detail(request.params.tmdbId, request.params.seasonNumber, locale, await ownerId(readSessionToken(request, config.SESSION_COOKIE_NAME))));
  });
}
