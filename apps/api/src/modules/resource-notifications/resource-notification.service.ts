import type { Locale, ResourceNotificationList, WatchlistMediaType } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { createResourceNotification } from './resource-notification.domain.js';
import { RESOURCE_NOTIFICATION_LIMIT } from './resource-notification.policy.js';
import { resourceNotificationMessages } from './resource-notification.presentation.js';
import type { ResourceNotificationDependencies, ResourceNotificationStore } from './resource-notification.types.js';

export class ResourceNotificationService {
  wake?: () => void;

  constructor(readonly store: ResourceNotificationStore, readonly dependencies: ResourceNotificationDependencies) {}

  async membership(ownerId: string, mediaType: WatchlistMediaType, tmdbId: number) {
    const entry = (await aiStep('resource-notification.membership.read', () => this.store.list(ownerId))).find(
      (item) => item.mediaType === mediaType && item.tmdbId === tmdbId
    );
    return entry ? { enabled: true, status: entry.status } : { enabled: false };
  }

  async list(ownerId: string, locale: Locale): Promise<ResourceNotificationList> {
    const entries = await aiStep('resource-notification.list.read', () => this.store.list(ownerId));
    const movies = await aiStep('resource-notification.catalog.movies', () =>
      this.dependencies.movies.readMovies(
        entries.filter((e) => e.mediaType === 'movie').map((e) => e.tmdbId),
        locale
      )
    );
    const tv = await aiStep('resource-notification.catalog.tv', () =>
      this.dependencies.tv.readSummaries(
        entries.filter((e) => e.mediaType === 'tv').map((e) => e.tmdbId),
        locale
      )
    );
    return {
      limit: RESOURCE_NOTIFICATION_LIMIT,
      locale,
      items: entries.map((entry) => {
        const movie = entry.mediaType === 'movie' ? movies.find((item) => item.tmdbId === entry.tmdbId) : undefined;
        const show = entry.mediaType === 'tv' ? tv.find((item) => item.tmdbId === entry.tmdbId) : undefined;
        const poster = movie?.posterPath ?? show?.posterPath;
        return {
          id: entry.id,
          mediaType: entry.mediaType,
          tmdbId: entry.tmdbId,
          title: movie?.title ?? show?.name ?? entry.title,
          ...(poster ? { posterUrl: `https://image.tmdb.org/t/p/w342${poster}` } : {}),
          status: entry.status,
          createdAt: entry.createdAt.toISOString(),
          ...(entry.notifiedAt ? { notifiedAt: entry.notifiedAt.toISOString() } : {}),
          ...(entry.lastOutcome ? { lastOutcome: entry.lastOutcome } : {}),
        };
      }),
    };
  }

  async add(ownerId: string, mediaType: WatchlistMediaType, tmdbId: number, locale: Locale) {
    const existing = await this.membership(ownerId, mediaType, tmdbId);
    if (existing.enabled) return existing;
    const channels = await aiStep('resource-notification.channels.read', () =>
      this.dependencies.notifications.listChannels(ownerId)
    );
    if (!channels.some((channel) => channel.configured))
      throw new AppError(
        409,
        'RESOURCE_NOTIFICATION_CHANNEL_REQUIRED',
        resourceNotificationMessages[locale].channelsRequired
      );
    const title
      = mediaType === 'movie'
        ? (
            await aiStep('resource-notification.movie.read', () =>
              this.dependencies.movies.readMovies([tmdbId], locale)
            )
          )[0]?.title
        : (await aiStep('resource-notification.tv.read', () => this.dependencies.tv.readSummaries([tmdbId], locale)))[0]
            ?.name;
    if (!title) throw new AppError(404, 'NOT_FOUND', resourceNotificationMessages[locale].notFound);
    const entry = createResourceNotification(
      mediaType,
      tmdbId,
      title,
      this.dependencies.now?.() ?? new Date(),
      currentAiTrace()?.correlationId
    );
    if (!(await aiStep('resource-notification.add.persist', () => this.store.add(ownerId, entry))))
      throw new AppError(409, 'RESOURCE_NOTIFICATION_LIMIT_REACHED', resourceNotificationMessages[locale].limitReached);
    this.wake?.();
    return this.membership(ownerId, mediaType, tmdbId);
  }

  async remove(ownerId: string, mediaType: WatchlistMediaType, tmdbId: number) {
    await aiStep('resource-notification.remove.persist', () => this.store.remove(ownerId, mediaType, tmdbId));
    return { enabled: false };
  }
}
