import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { NotificationLocaleOptions } from './notification.types.js';
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
    private readonly now: () => Date = () => new Date(),
    private readonly localeOptions: NotificationLocaleOptions = {}
  ) {}

  async list(token: string | undefined, page: number): Promise<NotificationTestList> {
    const owner = await this.auth.requireOwnerId(token);
    const locale = await aiStep('notification.locale.read', async () =>
      await this.localeOptions.resolveLocale?.(owner) ?? this.locale);
    const records = await this.store.listCompleted(owner, (page - 1) * 30, 31);
    const visible = records.slice(0, 30);
    const movies = await this.movies.readMovies(
      [
        ...new Set(
          visible.map((row) => {
            return row.tmdbId;
          }).filter((id): id is number => id !== undefined)
        ),
      ],
      locale
    );
    const byId = new Map(movies.map((movie) => [movie.tmdbId, movie]));
    return {
      channels: await this.notifications.listChannels(owner),
      page,
      hasMore: records.length > 30,
      items: visible.filter((record) => Boolean(record.provider)).map((record) => {
        const movie = record.tmdbId !== undefined ? byId.get(record.tmdbId) : undefined;
        return {
          id: record.id,
          ...(record.tmdbId !== undefined ? { tmdbId: record.tmdbId } : {}),
          title: movie?.title ?? record.name ?? (record.tmdbId !== undefined ? `TMDB ${record.tmdbId}` : record.sourceReleaseId),
          resourceName: record.name ?? (record.tmdbId !== undefined ? `TMDB ${record.tmdbId}` : record.sourceReleaseId),
          provider: record.provider!,
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
      const locale = await aiStep('notification.locale.read', async () =>
        await this.localeOptions.resolveLocale?.(owner) ?? this.locale);
      const payload = await this.payload(
        record,
        randomUUID(),
        record.lastSyncedAt ?? this.now(),
        this.movies,
        locale,
        this.webOrigin
      );
      this.lastSent.set(key, this.now().getTime());
      try {
        await aiStep('notification.channel.send', () => channel.send(owner, payload), { channel: channel.id });
        return { results: [{ channel: channel.id, sent: true }] };
      } catch (error) {
        currentAiTrace()?.fail(error);
        currentAiTrace()?.clearFailure();
        return { results: [{ channel: channel.id, sent: false }] };
      }
    } finally {
      this.sending.delete(key);
    }
  }
}
