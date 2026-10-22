import type { NotificationTestStore } from './notification-test.types.js';
import { randomUUID } from 'node:crypto';
import type { Locale, NotificationTestList, NotificationTestResult } from '@movie-hub/contract';

import type { MovieCatalogStore } from '../movies/movie.types.js';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { NotificationService } from './notification.service.js';
import { buildDownloadNotification } from './notification.worker.js';

export class NotificationTestService {
  private readonly sending = new Set<string>();
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly store: NotificationTestStore,
    private readonly notifications: NotificationService,
    private readonly movies: Pick<MovieCatalogStore, 'readMovies'>,
    private readonly locale: Locale,
    private readonly webOrigin: string,
    private readonly payload = buildDownloadNotification,
    private readonly now: () => Date = () => new Date()
  ) {}

  async list(token: string | undefined, page: number): Promise<NotificationTestList> {
    const owner = await this.auth.requireOwnerId(token);
    const records = await this.store.listCompleted(owner, (page - 1) * 30, 31);
    const visible = records.slice(0, 30);
    const movies = await this.movies.readMovies(
      [
        ...new Set(
          visible.map((row) => {
            return row.tmdbId;
          })
        ),
      ],
      this.locale
    );
    const byId = new Map(movies.map((movie) => [movie.tmdbId, movie]));
    return {
      channels: await this.notifications.listChannels(owner),
      page,
      hasMore: records.length > 30,
      items: visible.map((record) => {
        const movie = byId.get(record.tmdbId);
        return {
          id: record.id,
          tmdbId: record.tmdbId,
          title: movie?.title ?? record.name ?? `TMDB ${record.tmdbId}`,
          resourceName: record.name ?? `TMDB ${record.tmdbId}`,
          provider: record.provider,
          ...(record.downloaderInstanceId ? { downloaderInstanceId: record.downloaderInstanceId } : {}),
          ...(record.downloaderName ? { downloaderName: record.downloaderName } : {}),
          totalBytes: record.totalBytes ?? 0,
          ...(movie?.posterPath ? { posterUrl: `https://image.tmdb.org/t/p/w185${movie.posterPath}` } : {}),
          ...(record.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt.toISOString() } : {}),
        };
      }),
    };
  }

  async send(token: string | undefined, id: string, channelId: string): Promise<NotificationTestResult> {
    const owner = await this.auth.requireOwnerId(token);
    const record = await this.store.findCompleted(owner, id);
    if (!record) throw new AppError(404, 'NOT_FOUND', 'Completed download not found');
    const key = `${owner}:${channelId}`;
    const lastSent = this.lastSent.get(key);
    if (this.sending.has(key) || (lastSent !== undefined && this.now().getTime() - lastSent < 30_000))
      throw new AppError(409, 'CONFLICT', 'Wait 30 seconds before another notification test');
    this.sending.add(key);
    try {
      const channel = this.notifications.channel(channelId);
      if (!channel) throw new AppError(400, 'VALIDATION_ERROR', 'Unsupported notification channel');
      if (!(await channel.isConfigured(owner)))
        throw new AppError(409, 'CONFLICT', 'Link the selected notification channel first');
      const payload = await this.payload(
        record,
        randomUUID(),
        record.lastSyncedAt ?? this.now(),
        this.movies,
        this.locale,
        this.webOrigin
      );
      this.lastSent.set(key, this.now().getTime());
      try {
        await channel.send(owner, payload);
        return { results: [{ channel: channel.id, sent: true }] };
      } catch {
        return { results: [{ channel: channel.id, sent: false }] };
      }
    } finally {
      this.sending.delete(key);
    }
  }
}
