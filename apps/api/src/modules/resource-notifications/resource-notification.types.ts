import type { Locale, ResourceNotificationItem, WatchlistMediaType } from '@movie-hub/contract';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import type { MovieCatalogStore } from '../movies/movie.types.js';
import type { TvShowCatalogStore } from '../tv-shows/tv-show.types.js';
import type { NotificationService } from '../notifications/notification.service.js';
import type { ResourceSearchService } from '../resource-search/resource-search.service.js';

export interface ResourceNotificationEntry {
  id: string;
  correlationId: string;
  attempts: number;
  mediaType: WatchlistMediaType;
  tmdbId: number;
  title: string;
  status: 'pending' | 'notified';
  createdAt: Date;
  nextRunAt: Date;
  lockedUntil: Date;
  leaseId?: string;
  notifiedAt?: Date;
  lastOutcome?: ResourceNotificationItem['lastOutcome'];
}
export interface ResourceNotificationClaim {
  ownerId: string;
  entry: ResourceNotificationEntry;
  leaseId: string;
}
export interface ResourceNotificationStore {
  list(ownerId: string): Promise<ResourceNotificationEntry[]>;
  add(ownerId: string, entry: ResourceNotificationEntry): Promise<boolean>;
  remove(ownerId: string, mediaType: WatchlistMediaType, tmdbId: number): Promise<void>;
  claim(now: Date, nextRunAt: Date): Promise<ResourceNotificationClaim | null>;
  renew(claim: ResourceNotificationClaim, now: Date): Promise<boolean>;
  markNotified(claim: ResourceNotificationClaim, now: Date): Promise<boolean>;
  finish(
    claim: ResourceNotificationClaim,
    outcome: NonNullable<ResourceNotificationItem['lastOutcome']>,
  ): Promise<void>;
}
export interface ResourceFoundNotification {
  kind: 'resource-found';
  id: string;
  title: string;
  resourceName: string;
  site: string;
  foundAt: Date;
  detailUrl: string;
  locale: Locale;
  poster?: Buffer;
}
export interface ResourceNotificationDependencies {
  notifications: Pick<NotificationService, 'listChannels' | 'channel'>;
  movies: Pick<MovieCatalogStore, 'readMovieDetail' | 'readMovies'>;
  tv: Pick<TvShowCatalogStore, 'readDetail' | 'readSummaries'>;
  search: Pick<ResourceSearchService, 'search'>;
  enabledSites(ownerId: string): Promise<string[]>;
  resolveLocale(ownerId: string): Promise<Locale>;
  logger: AiLogger;
  verbose: boolean;
  webOrigin: string;
  intervalMs: number;
  now?: () => Date;
}
