import type { Locale, WatchlistMediaType, WatchlistResponse } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { MovieStatusService } from '../movie-statuses/movie-status.service.js';
import type { TvShowCatalogStore } from '../tv-shows/tv-show.types.js';
import { tvShowSummary, definedFields } from '../tv-shows/tv-show.domain.js';
import { tvShowMessages } from '../tv-shows/tv-show.presentation.js';
import { watchlistItemNotFound, unavailableWatchlistTitle } from './watchlist.presentation.js';
import type { TvWatchlistStore, WatchlistMovieStore } from './watchlist.types.js';

import type { ResourceNotificationService } from '../resource-notifications/resource-notification.service.js';

export class WatchlistService {
  constructor(
    private readonly movies: MovieStatusService,
    private readonly catalog: TvShowCatalogStore,
    private readonly tv: TvWatchlistStore,
    private readonly movieStates: WatchlistMovieStore,
    private readonly resourceNotifications?: ResourceNotificationService
  ) {}

  async list(ownerId: string, mediaType: WatchlistMediaType, page: number, pageSize: number, locale: Locale): Promise<WatchlistResponse> {
    const notifications = this.resourceNotifications ? await this.resourceNotifications.store.list(ownerId) : undefined;
    if (mediaType === 'movie') {
      const result = await aiStep('watchlist.movies.list', () => this.movies.list(ownerId, 'interested', page, pageSize, locale));
      const states = await aiStep('watchlist.movies.identities', () => this.movieStates.list(ownerId, 'interested', page, pageSize));
      const byId = new Map(result.items.map((item) => [item.tmdbId, item]));
      return { ...result, items: states.items.map((state) => {
        const item = byId.get(state.tmdbId);
        return definedFields({ mediaType: 'movie' as const, tmdbId: state.tmdbId, resourceNotificationEnabled: notifications ? notifications.some((entry) => entry.mediaType === 'movie' && entry.tmdbId === state.tmdbId) : state.resourceNotificationEnabled ?? false, title: item?.title || unavailableWatchlistTitle(locale, state.tmdbId), overview: item?.overview, posterUrl: item?.posterUrl, releaseDate: item?.releaseDate, voteAverage: item?.voteAverage });
      }) };
    }
    const result = await aiStep('watchlist.tv.list', () => this.tv.list(ownerId, page, pageSize));
    const shows = await aiStep('watchlist.tv.catalog', () => this.catalog.readSummaries(result.ids, locale));
    const missing = result.ids.filter((id) => !shows.some((show) => show.tmdbId === id));
    const fallback = missing.length ? await aiStep('watchlist.tv.catalog.fallback', () => this.catalog.readSummaries(missing, locale === 'zh-CN' ? 'en-US' : 'zh-CN')) : [];
    const byId = new Map([...fallback, ...shows].map((show) => [show.tmdbId, tvShowSummary(show)]));
    return { items: result.ids.flatMap((tmdbId) => {
      const show = byId.get(tmdbId);
      return [definedFields({ mediaType: 'tv' as const, tmdbId, resourceNotificationEnabled: notifications ? notifications.some((entry) => entry.mediaType === 'tv' && entry.tmdbId === tmdbId) : result.notificationEnabledIds.includes(tmdbId), title: show?.name || show?.originalName || unavailableWatchlistTitle(locale, tmdbId), overview: show?.overview, posterUrl: show?.posterUrl, releaseDate: show?.firstAirDate, voteAverage: show?.voteAverage })];
    }), pagination: { page, pageSize, total: result.total, hasMore: page * pageSize < result.total }, locale };
  }

  async remove(ownerId: string, mediaType: WatchlistMediaType, tmdbId: number) {
    if (mediaType === 'movie') await aiStep('watchlist.movies.remove', () => this.movies.clear(ownerId, tmdbId));
    else await this.removeTv(ownerId, tmdbId);
    return { inWatchlist: false };
  }

  async setResourceNotification(ownerId: string, mediaType: WatchlistMediaType, tmdbId: number, enabled: boolean, locale: Locale) {
    if (this.resourceNotifications) return enabled
      ? this.resourceNotifications.add(ownerId, mediaType, tmdbId, locale)
      : this.resourceNotifications.remove(ownerId, mediaType, tmdbId);
    const store = mediaType === 'movie' ? this.movieStates : this.tv;
    const found = await aiStep('watchlist.resource-notification.save', () => store.setResourceNotification(ownerId, tmdbId, enabled));
    if (!found) throw new AppError(404, 'NOT_FOUND', watchlistItemNotFound(locale));
    return { enabled };
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
