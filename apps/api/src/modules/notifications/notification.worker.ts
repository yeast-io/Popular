import { TaskLease } from '../../infrastructure/background-tasks/task-lease.worker.js';
import { beginTaskStatistics } from '../../infrastructure/background-tasks/task-statistics.adapter.js';
import type { TaskStatistics } from '../../infrastructure/background-tasks/background-task.types.js';
import { TaskRunner } from '../../infrastructure/background-tasks/task-runner.worker.js';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { remoteDownloadMessages } from '../remote-downloads/remote-download.messages.js';
import { DOWNLOAD_NOTIFICATION_SCAN_MS } from './notification.policy.js';
import { loadTmdbPoster as loadPoster } from '../../infrastructure/tmdb/poster.js';
import { serializeDiagnosticError } from '../../infrastructure/logging/diagnostic-error.js';
import type { Locale } from '@movie-hub/contract';
import type { MovieDownloadService } from '../downloads/movie-download.service.js';
import type { MovieCatalogStore } from '../movies/movie.types.js';
import type { NotificationService } from './notification.service.js';
import type { ClaimedDownload, DownloadNotification, NotificationLocaleOptions } from './notification.types.js';

export class NotificationWorker {
  private readonly runner: TaskRunner;

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
    scanTraceEnabled = false,
    private readonly localeOptions: NotificationLocaleOptions = {},
    private readonly statistics?: TaskStatistics
  ) {
    this.runner = new TaskRunner({
      statistics,
      name: 'download-notifications', intervalMs: DOWNLOAD_NOTIFICATION_SCAN_MS,
      logger: localeOptions.logger, verbose: localeOptions.verbose === true && scanTraceEnabled,
      run: ({ signal }) => this.run(signal),
      onError: (error) => this.report('SCAN_FAILED', { error: serializeDiagnosticError(error) }),
    });
  }

  start() { this.runner.start(); }

  stop() { return this.runner.stop(); }

  tick() { return this.runner.tick(); }

  private async run(signal: AbortSignal) {
    const store = this.service.store;
    for (let i = 0; i < 20 && !signal.aborted; i++) {
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
    for (let i = 0; i < 20 && !signal.aborted; i++) {
      const claim = await store.claimTask(this.now());
      if (!claim) break;
      const trace = new AiTrace(this.localeOptions.logger, { taskId: claim.task.id, downloadId: claim.record.id },
        '', 'notification.download', this.localeOptions.verbose === true);
      await withAiTrace(trace, async () => {
        trace.event('notification.started');
        await this.process(claim, signal);
      });
    }
  }

  private async active(claim: ClaimedDownload, signal: AbortSignal) {
    const preferences = await this.service.store.preferences(claim.record.ownerId);
    if (signal.aborted) return false;
    if (!preferences.enabled || preferences.epoch !== claim.task.epoch) {
      await this.service.store.cancel(claim);
      return false;
    }
    return true;
  }

  private async process(claim: ClaimedDownload, signal: AbortSignal) {
    const store = this.service.store;
    let error: string | undefined;
    const lease = new TaskLease({ signal, intervalMs: 30_000, renew: () => store.renew(claim, this.now()) });
    const finishStatistics = beginTaskStatistics(this.statistics, 'download-notifications', 'job');
    lease.start();
    try {
      if (!(await this.active(claim, lease.signal)) || !(await lease.renew())) return;
      if (!claim.task.downloaded) {
        const progress = await aiStep('notification.download.inspect', () => this.downloads.inspect(claim.record));
        if (!progress) {
          error = 'DOWNLOAD_NOT_FOUND';
          return;
        }
        if (!(await store.downloaded(claim, progress, this.now())) || !claim.task.downloaded) return;
      }
      const payload = await this.payload(claim);
      for (const target of claim.task.channels) {
        if (target.notified) continue;
        if (!(await this.active(claim, lease.signal)) || !(await lease.renew())) return;
        const channel = this.service.channel(target.channel);
        try {
          if (!channel || !(await channel.isConfigured(claim.record.ownerId))) {
            error = 'CHANNEL_UNAVAILABLE';
            continue;
          }
          if (!(await lease.renew())) return;
          const sent = await aiStep('notification.channel.send', () => channel.send(claim.record.ownerId, payload), { channel: target.channel });
          if (!(await store.channelNotified(claim, target.channel, sent.messageId))) return;
        } catch (cause) {
          currentAiTrace()?.fail(cause, { channel: target.channel });
          currentAiTrace()?.clearFailure();
          error = 'NOTIFICATION_SEND_FAILED';
        }
      }
    } catch (cause) {
      currentAiTrace()?.fail(cause);
      error = 'DOWNLOAD_CHECK_FAILED';
    } finally {
      const cancelled = lease.signal.aborted;
      await lease.stop();
      let persisted = false;
      try {
        await store.finish(claim, this.now(), error);
        persisted = true;
        if (error) this.report(error);
        currentAiTrace()?.event('notification.completed', { outcome: error ?? 'success' });
      } finally {
        finishStatistics(!persisted ? 'failure' : cancelled ? 'cancelled' : error ? 'failure' : 'success');
      }
    }
  }

  private async payload(claim: ClaimedDownload): Promise<DownloadNotification> {
    const locale = await aiStep('notification.locale.read', async () =>
      this.localeOptions.resolveLocale ? this.localeOptions.resolveLocale(claim.record.ownerId) : this.locale);
    return buildDownloadNotification(
      claim.record,
      claim.task.id,
      claim.task.completedAt ?? this.now(),
      this.movies,
      locale,
      this.webOrigin,
      this.poster
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
  posterLoader: (path: string) => Promise<Buffer | undefined> = loadPoster
): Promise<DownloadNotification> {
  let movie;
  try {
    const tmdbId = record.tmdbId;
    if (tmdbId !== undefined) movie = (await aiStep('notification.movie.read', () => movies.readMovies([tmdbId], locale)))[0];
    currentAiTrace()?.event('notification.movie.resolved', { locale, outcome: movie ? 'found' : 'missing' });
  } catch (error) {
    currentAiTrace()?.fail(error);
    currentAiTrace()?.clearFailure();
    /* use persisted download info */
  }
  let poster: Buffer | undefined;
  if (movie?.posterPath) {
    try {
      poster = await aiStep('notification.poster.load', () => posterLoader(movie!.posterPath!));
    } catch (error) {
      currentAiTrace()?.fail(error);
      currentAiTrace()?.clearFailure();
      /* text fallback */
    }
  }
  currentAiTrace()?.event('notification.poster.resolved', { outcome: poster?.length ? 'loaded' : 'missing' });
  return {
    id,
    locale,
    title: movie?.title ?? record.name ?? (record.tmdbId !== undefined ? `TMDB ${record.tmdbId}` : record.sourceReleaseId),
    resourceName: record.name ?? (record.tmdbId !== undefined ? `TMDB ${record.tmdbId}` : record.sourceReleaseId),
    provider: record.downloaderName ?? record.provider ?? remoteDownloadMessages[locale].agent,
    totalBytes: record.totalBytes ?? 0,
    completedAt,
    detailUrl: record.tmdbId !== undefined ? `${webOrigin.replace(/\/$/, '')}/movies/${record.tmdbId}` : record.sourceDetailsUrl ?? webOrigin,
    ...(poster ? { poster } : {}),
  };
}
