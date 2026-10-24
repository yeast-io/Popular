import type { Locale, WatchlistMediaType, WatchlistResponse } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { MovieStatusService } from '../movie-statuses/movie-status.service.js';
import type { TvShowCatalogStore } from '../tv-shows/tv-show.types.js';
import { tvShowSummary, definedFields } from '../tv-shows/tv-show.domain.js';
import { tvShowMessages } from '../tv-shows/tv-show.presentation.js';
import type { MovieStatusStore } from '../movies/movie.types.js';
import { unavailableWatchlistTitle } from './watchlist.presentation.js';
import type { TvWatchlistStore } from './watchlist.types.js';

export class WatchlistService {
  constructor(
    private readonly movies: MovieStatusService,
    private readonly catalog: TvShowCatalogStore,
    private readonly tv: TvWatchlistStore,
    private readonly movieStates: Pick<MovieStatusStore, 'list'>
  ) {}

  async list(ownerId: string, mediaType: WatchlistMediaType, page: number, pageSize: number, locale: Locale): Promise<WatchlistResponse> {
    if (mediaType === 'movie') {
      const result = await aiStep('watchlist.movies.list', () => this.movies.list(ownerId, 'interested', page, pageSize, locale));
      const states = await aiStep('watchlist.movies.identities', () => this.movieStates.list(ownerId, 'interested', page, pageSize));
      const byId = new Map(result.items.map((item) => [item.tmdbId, item]));
      return { ...result, items: states.items.map((state) => {
        const item = byId.get(state.tmdbId);
        return definedFields({ mediaType: 'movie' as const, tmdbId: state.tmdbId, title: item?.title || unavailableWatchlistTitle(locale, state.tmdbId), overview: item?.overview, posterUrl: item?.posterUrl, releaseDate: item?.releaseDate, voteAverage: item?.voteAverage });
      }) };
    }
    const result = await aiStep('watchlist.tv.list', () => this.tv.list(ownerId, page, pageSize));
    const shows = await aiStep('watchlist.tv.catalog', () => this.catalog.readSummaries(result.ids, locale));
    const missing = result.ids.filter((id) => !shows.some((show) => show.tmdbId === id));
    const fallback = missing.length ? await aiStep('watchlist.tv.catalog.fallback', () => this.catalog.readSummaries(missing, locale === 'zh-CN' ? 'en-US' : 'zh-CN')) : [];
    const byId = new Map([...fallback, ...shows].map((show) => [show.tmdbId, tvShowSummary(show)]));
    return { items: result.ids.flatMap((tmdbId) => {
      const show = byId.get(tmdbId);
      return [definedFields({ mediaType: 'tv' as const, tmdbId, title: show?.name || show?.originalName || unavailableWatchlistTitle(locale, tmdbId), overview: show?.overview, posterUrl: show?.posterUrl, releaseDate: show?.firstAirDate, voteAverage: show?.voteAverage })];
    }), pagination: { page, pageSize, total: result.total, hasMore: page * pageSize < result.total }, locale };
  }

  async membership(ownerId: string, tmdbId: number) {
    return { inWatchlist: await aiStep('watchlist.tv.membership', () => this.tv.contains(ownerId, tmdbId)) };
  }

  async addTv(ownerId: string, tmdbId: number, locale: Locale) {
    const shows = await aiStep('watchlist.tv.validate', () => this.catalog.readSummaries([tmdbId], locale));
    if (!shows.length) throw new AppError(404, 'NOT_FOUND', tvShowMessages(locale).notFound);
    await aiStep('watchlist.tv.add', () => this.tv.add(ownerId, tmdbId));
    return { inWatchlist: true };
  }

  async removeTv(ownerId: string, tmdbId: number) {
    await aiStep('watchlist.tv.remove', () => this.tv.remove(ownerId, tmdbId));
    return { inWatchlist: false };
  }
}
