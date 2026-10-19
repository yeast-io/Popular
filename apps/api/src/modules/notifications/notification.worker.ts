import { loadTmdbPoster as loadPoster } from '../../infrastructure/tmdb/poster.js';
import { serializeDiagnosticError } from '../../infrastructure/logging/diagnostic-error.js';
import type { Locale } from '@movie-hub/contract';
import type { MovieDownloadService } from '../downloads/movie-download.service.js';
import type { MovieCatalogStore } from '../movies/movie.types.js';
import type { NotificationService } from './notification.service.js';
import type { ClaimedDownload, DownloadNotification } from './notification.types.js';

export class NotificationWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private readonly service: NotificationService,
    private readonly downloads: Pick<MovieDownloadService, 'inspect'>,
    private readonly movies: Pick<MovieCatalogStore, 'readMovies'>,
    private readonly locale: Locale,
    private readonly webOrigin: string,
    private readonly report: (event: string, fields?: Record<string, unknown>) => void = () => {
      return undefined;
    },
    private readonly now: () => Date = () => new Date(),
    private readonly poster: (path: string) => Promise<Buffer | undefined> = loadPoster,
    private readonly scanTraceEnabled = false
  ) {}
  start() {
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5_000);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async tick(): Promise<void> {
    if (this.running || this.stopped) return this.running;
    const started = Date.now();
    if (this.scanTraceEnabled) this.report('SCAN_STARTED');
    this.running = this.run()
      .then(() => {
        if (this.scanTraceEnabled) this.report('SCAN_COMPLETED', { durationMs: Date.now() - started });
      })
      .catch((error) => this.report('SCAN_FAILED', { error: serializeDiagnosticError(error) }));
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }
  private async run() {
    const store = this.service.store;
    for (let i = 0; i < 20 && !this.stopped; i++) {
      const intent = await store.claimIntent(this.now());
      if (!intent) break;
      try {
        const preferences = await store.preferences(intent.record.ownerId);
        if (!preferences.enabled || preferences.epoch !== intent.plan.epoch) {
          await store.releaseIntent(intent, this.now(), true);
          continue;
        }
        const progress = await this.downloads.inspect(intent.record);
        if (progress)
          await store.activate(intent.record.ownerId, intent.record.id, this.now(), intent.leaseId, progress);
        else await store.releaseIntent(intent, this.now(), ['failed', 'missing'].includes(intent.record.status));
      } catch {
        await store.releaseIntent(intent, this.now(), false);
        this.report('INTENT_RECOVERY_FAILED');
      }
    }
    for (let i = 0; i < 20 && !this.stopped; i++) {
      const claim = await store.claimTask(this.now());
      if (!claim) break;
      await this.process(claim);
    }
  }
  private async active(claim: ClaimedDownload) {
    const preferences = await this.service.store.preferences(claim.record.ownerId);
    if (this.stopped) return false;
    if (!preferences.enabled || preferences.epoch !== claim.task.epoch) {
      await this.service.store.cancel(claim);
      return false;
    }
    return this.service.store.renew(claim, this.now());
  }
  private async process(claim: ClaimedDownload) {
    const store = this.service.store;
    let error: string | undefined;
    try {
      if (!(await this.active(claim))) return;
      if (!claim.task.downloaded) {
        const progress = await this.downloads.inspect(claim.record);
        if (!progress) {
          error = 'DOWNLOAD_NOT_FOUND';
          return;
        }
        if (!(await store.downloaded(claim, progress, this.now())) || !claim.task.downloaded) return;
      }
      const payload = await this.payload(claim);
      for (const target of claim.task.channels) {
        if (target.notified) continue;
        if (!(await this.active(claim))) return;
        const channel = this.service.channel(target.channel);
        try {
          if (!channel || !(await channel.isConfigured(claim.record.ownerId))) {
            error = 'CHANNEL_UNAVAILABLE';
            continue;
          }
          const sent = await channel.send(claim.record.ownerId, payload);
          if (!(await store.channelNotified(claim, target.channel, sent.messageId))) return;
        } catch {
          error = 'NOTIFICATION_SEND_FAILED';
        }
      }
    } catch {
      error = 'DOWNLOAD_CHECK_FAILED';
    } finally {
      await store.finish(claim, this.now(), error);
      if (error) this.report(error);
    }
  }
  private async payload(claim: ClaimedDownload): Promise<DownloadNotification> {
    return buildDownloadNotification(
      claim.record,
      claim.task.id,
      claim.task.completedAt ?? this.now(),
      this.movies,
      this.locale,
      this.webOrigin,
      this.poster,
    );
  }
}

export async function buildDownloadNotification(
  record: import('../downloads/movie-download.types.js').MovieDownloadRecord,
  id: string,
  completedAt: Date,
  movies: Pick<MovieCatalogStore, 'readMovies'>,
  locale: Locale,
  webOrigin: string,
  posterLoader: (path: string) => Promise<Buffer | undefined> = loadPoster,
): Promise<DownloadNotification> {
  let movie;
  try {
    movie = (await movies.readMovies([record.tmdbId], locale))[0];
  } catch {
    /* use persisted download info */
  }
  let poster: Buffer | undefined;
  if (movie?.posterPath) {
    try {
      poster = await posterLoader(movie.posterPath);
    } catch {
      /* text fallback */
    }
  }
  return {
    id,
    title: movie?.title ?? record.name ?? `TMDB ${record.tmdbId}`,
    resourceName: record.name ?? `TMDB ${record.tmdbId}`,
    provider: record.provider,
    totalBytes: record.totalBytes ?? 0,
    completedAt,
    detailUrl: `${webOrigin.replace(/\/$/, '')}/movies/${record.tmdbId}`,
    ...(poster ? { poster } : {}),
  };
}
