import { setTimeout as wait } from 'node:timers/promises';
import { MTEAM_SEARCH_MINIMUM_INTERVAL_MS } from '../resource-search/resource-search.policy.js';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { Locale, ResourceSiteRelease } from '@movie-hub/contract';
import type { ResourceNotificationService } from './resource-notification.service.js';
import type { ResourceNotificationClaim, ResourceFoundNotification } from './resource-notification.types.js';
import { matchesTvResource } from './resource-notification.domain.js';
import { RESOURCE_NOTIFICATION_SCAN_MS } from './resource-notification.policy.js';

export class ResourceNotificationWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<void> | undefined;
  private stopped = false;
  private readonly siteReadyAt = new Map<string, number>();

  constructor(private readonly service: ResourceNotificationService) {
    service.wake = () => {
      void this.tick();
    };
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, RESOURCE_NOTIFICATION_SCAN_MS);
    this.timer.unref();
    void this.tick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  tick(): Promise<void> {
    if (this.running || this.stopped) return this.running ?? Promise.resolve();
    this.running = this.run()
      .catch((error) => {
        this.service.dependencies.logger.error(
          { err: error, stage: 'resource-notification.scan' },
          'Resource notification scan failed'
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private now() {
    return this.service.dependencies.now?.() ?? new Date();
  }

  private async run() {
    const { store, dependencies } = this.service;
    for (let count = 0; count < 50 && !this.stopped; count++) {
      const now = this.now();
      const claim = await store.claim(now, new Date(now.getTime() + dependencies.intervalMs));
      if (!claim) break;
      const trace = new AiTrace(
        dependencies.logger,
        {
          ownerId: claim.ownerId,
          taskId: claim.entry.id,
          correlationId: claim.entry.correlationId,
          leaseId: claim.leaseId,
          attempt: claim.entry.attempts,
        },
        '',
        'resource-notification.worker',
        dependencies.verbose
      );
      await withAiTrace(trace, () => aiStep('resource-notification.execute', () => this.process(claim)));
    }
  }

  private async find(
    claim: ResourceNotificationClaim,
    locale: Locale
  ): Promise<{ release: ResourceSiteRelease; site: string } | undefined> {
    const { dependencies } = this.service;
    const { ownerId, entry } = claim;
    const movie
      = entry.mediaType === 'movie'
        ? await aiStep('resource-notification.identity.movie', () =>
            dependencies.movies.readMovieDetail(entry.tmdbId, locale)
          )
        : undefined;
    const show
      = entry.mediaType === 'tv'
        ? await aiStep('resource-notification.identity.tv', () => dependencies.tv.readDetail(entry.tmdbId, locale))
        : undefined;
    // Movie identity must be exact; do not fall back to broad title searches.
    if (entry.mediaType === 'movie' && !movie?.imdbId) return;
    if (entry.mediaType === 'tv' && !show) return;
    const sites = await aiStep('resource-notification.sites.read', () => dependencies.enabledSites(ownerId));
    let lastFailure: unknown;
    for (const site of sites) {
      if (this.stopped) return;
      const key = `${ownerId}:${site}`;
      try {
        const signal = AbortSignal.timeout(60_000);
        let page: number | undefined = 1;
        while (page !== undefined && !this.stopped) {
          const delay = (this.siteReadyAt.get(key) ?? 0) - Date.now();
          if (delay > 0) await wait(delay, undefined, { signal });
          if (this.stopped) return;
          const currentPage: number = page;
          const result = await aiStep(
            'resource-notification.site.search',
            () =>
              dependencies.search.search(
                ownerId,
                site,
                movie?.imdbId
                  ? { imdbId: movie.imdbId, mediaType: 'movie', page: currentPage }
                  : { query: show!.originalName || show!.name, mediaType: 'tv', page: currentPage },
                signal,
                locale
              ),
            { site, page: currentPage }
          );
          if (site === 'mteam') this.siteReadyAt.set(key, Date.now() + MTEAM_SEARCH_MINIMUM_INTERVAL_MS);
          const release = result.releases.find((item) =>
            movie
              ? (!item.imdbId || item.imdbId === movie.imdbId) && (item.seeders === undefined || item.seeders > 0)
              : matchesTvResource(item, [show!.name, show!.originalName ?? ''])
          );
          if (release) return { release, site };
          page = result.nextPage;
          if (page !== undefined && (page <= currentPage || page > 100))
            throw new Error('Invalid resource search pagination');
        }
      } catch (error) {
        lastFailure = error;
        currentAiTrace()?.fail(error, { stage: 'resource-notification.site.search', site });
        currentAiTrace()?.clearFailure();
      } finally {
        if (site === 'mteam') this.siteReadyAt.set(key, Date.now() + MTEAM_SEARCH_MINIMUM_INTERVAL_MS);
      }
    }
    if (lastFailure) throw lastFailure;
  }

  private async process(claim: ResourceNotificationClaim) {
    const { store, dependencies } = this.service;
    let outcome: 'no-channels' | 'no-resources' | 'failed' | 'notified' = 'failed';
    let leaseAlive = true;
    let renewal: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewal = renewal.then(async () => {
        if (!leaseAlive) return;
        try {
          leaseAlive = await store.renew(claim, this.now());
        } catch (error) {
          leaseAlive = false;
          currentAiTrace()?.fail(error, { stage: 'resource-notification.lease.renew' });
        }
      });
    }, 30_000);
    heartbeat.unref();
    try {
      if (
        !(
          await aiStep('resource-notification.channels.preflight', () =>
            dependencies.notifications.listChannels(claim.ownerId)
          )
        ).some((channel) => channel.configured)
      ) {
        outcome = 'no-channels';
        return;
      }
      const locale = await aiStep('resource-notification.locale.read', () => dependencies.resolveLocale(claim.ownerId));
      const match = await this.find(claim, locale);
      if (!match) {
        outcome = 'no-resources';
        return;
      }
      const payload: ResourceFoundNotification = {
        kind: 'resource-found',
        id: claim.entry.id,
        title: claim.entry.title,
        resourceName: match.release.title,
        site: match.site,
        foundAt: this.now(),
        locale,
        detailUrl: `${dependencies.webOrigin.replace(/\/$/, '')}/${claim.entry.mediaType === 'movie' ? 'movies' : 'tv-shows'}/${claim.entry.tmdbId}`,
      };
      const channels = await aiStep('resource-notification.channels.refresh', () =>
        dependencies.notifications.listChannels(claim.ownerId)
      );
      if (!channels.some((channel) => channel.configured)) {
        outcome = 'no-channels';
        return;
      }
      for (const target of channels.filter((channel) => channel.configured)) {
        if (this.stopped || !leaseAlive || !(await store.renew(claim, this.now()))) return;
        const channel = dependencies.notifications.channel(target.id);
        if (!channel?.sendResource) continue;
        try {
          if (
            !(await aiStep('resource-notification.channel.check', () => channel.isConfigured(claim.ownerId), {
              channel: target.id,
            }))
          )
            continue;
          await aiStep('resource-notification.channel.send', () => channel.sendResource!(claim.ownerId, payload), {
            channel: target.id,
          });
        } catch (error) {
          currentAiTrace()?.fail(error, { stage: 'resource-notification.channel.send', channel: target.id });
          currentAiTrace()?.clearFailure();
          continue;
        }
        // Persist the first success immediately, even if a later channel fails.
        if (outcome !== 'notified') {
          if (!(await aiStep('resource-notification.success.persist', () => store.markNotified(claim, this.now()))))
            return;
          outcome = 'notified';
        }
      }
    } catch (error) {
      currentAiTrace()?.fail(error);
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await aiStep('resource-notification.finish', () => store.finish(claim, outcome), { outcome });
    }
  }
}
