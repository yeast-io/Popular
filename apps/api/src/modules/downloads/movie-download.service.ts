import type { AgentResourceService } from '../agent-resources/agent-resource.service.js';
import type { DownloadSourceService } from './download-source.service.js';
import { downloadClientError } from './download-client.errors.js';
import type { ResourceSearchService } from '../resource-search/resource-search.service.js';
import type { CreateResourceDownloadRequest, ResourceSiteRelease } from '@movie-hub/contract';
import { toResponse } from './movie-download.presentation.js';
import type { RemoteMovieDownloadService } from '../remote-downloads/remote-movie-download.service.js';
import type { Locale } from '@movie-hub/contract';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import type { IntegrationPreferencesService } from '../integrations/integration-preferences.service.js';
import type { TorrentSnapshot, DownloadClientFactory } from './movie-download-client.types.js';
import type {
  DownloadProvider,
  DownloaderChoice,
  DownloadSource,
  DownloadProviderListResponse,
  MovieDownload,
  MovieDownloadListResponse,
} from '@movie-hub/contract';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import type { MovieDownloadProgress, MovieDownloadRecord, MovieDownloadStore } from './movie-download.types.js';
import type { NotificationService } from '../notifications/notification.service.js';

export class MovieDownloadService {
  remote?: RemoteMovieDownloadService;
  agentResources?: AgentResourceService;
  resourceSearch?: Pick<ResourceSearchService, 'search'>;
  preferences?: Pick<IntegrationPreferencesService, 'get'>;
  private readonly syncs = new Map<string, Promise<MovieDownloadRecord[]>>();

  constructor(
    private readonly auth: AuthService,
    private readonly downloads: MovieDownloadStore,
    private readonly clients: DownloadClientFactory,
    private readonly sources: Pick<DownloadSourceService, 'prepareLocal'>,
    private readonly now: () => Date = () => new Date(),
    private readonly notifications?: Pick<NotificationService, 'reserve' | 'submitted'>
  ) {}

  async providers(token: string | undefined): Promise<DownloadProviderListResponse> {
    return { providers: await this.instancesFor(await this.auth.requireOwnerId(token)) };
  }

  async defaultProviderFor(ownerId: string): Promise<DownloadProvider | undefined> {
    return (await this.defaultInstanceFor(ownerId))?.provider;
  }

  async defaultInstanceFor(ownerId: string): Promise<DownloaderChoice | undefined> {
    const id = (await this.preferences?.get(ownerId))?.defaults.downloader;
    return (await this.instancesFor(ownerId)).find((instance) => instance.downloaderInstanceId === id);
  }

  async providersFor(ownerId: string): Promise<DownloadProvider[]> {
    return [...new Set((await this.instancesFor(ownerId)).map((instance) => instance.provider))];
  }

  async instancesFor(ownerId: string): Promise<DownloaderChoice[]> {
    if (await this.agentResources?.enabled(ownerId)) return [];
    return this.clients.instancesFor(ownerId);
  }

  async agentDeviceFor(ownerId: string): Promise<string | undefined> {
    return this.agentResources?.device(ownerId);
  }

  async create(
    token: string | undefined,
    tmdbId: number,
    releaseId: string,
    requestedProvider?: DownloadProvider,
    sourceProvider: DownloadSource = 'mteam',
    requestedInstanceId?: string,
    remoteDeviceId?: string,
    locale: Locale = 'en-US',
    sourceReleaseTitle?: string
  ): Promise<MovieDownload> {
    return this.createForOwner(
      await this.auth.requireOwnerId(token),
      tmdbId,
      releaseId,
      requestedProvider,
      sourceProvider,
      requestedInstanceId,
      remoteDeviceId,
      locale,
      sourceReleaseTitle
    );
  }

  async createResource(token: string | undefined, input: CreateResourceDownloadRequest, locale: Locale): Promise<MovieDownload> {
    const ownerId = await this.auth.requireOwnerId(token);
    if (!this.resourceSearch) throw new AppError(503, 'SERVICE_UNAVAILABLE', '');
    const source = input.sourceProvider ?? 'mteam';
    const result = await aiStep('download.resources.validate', () => this.resourceSearch!.search(ownerId, source,
      { query: input.query, mediaType: 'tv', page: input.page ?? 1 }, AbortSignal.timeout(30_000), locale), { source });
    const resource = result.releases.find((release) => release.id === input.sourceReleaseId);
    if (!resource) throw new AppError(404, 'NOT_FOUND', '');
    return this.createForOwner(ownerId, undefined, resource.id, input.provider, source, input.downloaderInstanceId,
      input.remoteDeviceId, locale, resource.title.slice(0, 512), resource);
  }

  /** Internal entry: owner identity must come from a verified channel binding or authenticated conversation. */
  async createForOwner(
    ownerId: string,
    tmdbId: number | undefined,
    releaseId: string,
    requestedProvider?: DownloadProvider,
    sourceProvider: DownloadSource = 'mteam',
    requestedInstanceId?: string,
    remoteDeviceId?: string,
    locale: Locale = 'en-US',
    sourceReleaseTitle?: string,
    resource?: ResourceSiteRelease
  ): Promise<MovieDownload> {
    const agentDevice = await this.agentResources?.device(ownerId);
    if (agentDevice) {
      if (requestedProvider || requestedInstanceId || (remoteDeviceId && remoteDeviceId !== agentDevice)) throw new ResourceSiteError('agentModeConflict');
      remoteDeviceId = agentDevice;
    }
    if (remoteDeviceId) {
      if (!this.remote || requestedInstanceId || requestedProvider)
        throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', '');
      return this.remote.create(ownerId, tmdbId, releaseId, sourceProvider, remoteDeviceId, locale, sourceReleaseTitle, resource);
    }
    const existing = await this.downloads.findByRelease(ownerId, tmdbId, releaseId, sourceProvider);
    if (existing?.executionMode === 'remote' && existing.status !== 'missing') return toResponse(existing);
    if (existing && existing.status !== 'missing' && requestedProvider && existing.provider !== requestedProvider) {
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'This release already belongs to another downloader');
    }
    if (existing && existing.status !== 'missing' && existing.downloaderInstanceId && requestedInstanceId && existing.downloaderInstanceId !== requestedInstanceId)
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'This release already belongs to another downloader');
    if (existing && !['failed', 'missing'].includes(existing.status)) return toResponse(existing);
    const choices = await this.instancesFor(ownerId);
    const pinnedId = requestedInstanceId ?? (existing?.status === 'missing' ? undefined : existing?.downloaderInstanceId);
    const selectedType = requestedProvider ?? (existing?.status === 'missing' ? undefined : existing?.provider);
    const candidates = pinnedId
      ? choices.filter((choice) => choice.downloaderInstanceId === pinnedId)
      : choices.filter((choice) => !selectedType || choice.provider === selectedType);
    const defaultId = !pinnedId && candidates.length > 1
      ? (await this.preferences?.get(ownerId))?.defaults.downloader
      : undefined;
    const selected = pinnedId
      ? candidates[0]
      : candidates.find((choice) => choice.downloaderInstanceId === defaultId) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!selected) {
      if (!choices.length) throw new AppError(409, 'DOWNLOAD_NOT_CONFIGURED', 'Configure a downloader before downloading');
      if (pinnedId || (requestedProvider && !candidates.length))
        throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'Selected downloader is unavailable');
      throw new AppError(409, 'DOWNLOAD_PROVIDER_REQUIRED', 'Choose a downloader');
    }
    const provider = selected.provider;
    if (requestedProvider && requestedProvider !== provider)
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'Selected downloader type differs');
    const client = await aiStep('download.client.load', () => this.clients.clientFor(ownerId, provider, selected.downloaderInstanceId, locale));
    if (existing && (existing.status !== 'missing'
      || (existing.executionMode !== 'remote' && existing.provider === provider
        && (!existing.downloaderInstanceId || existing.downloaderInstanceId === selected.downloaderInstanceId)))) {
      // Do not retry if recovery cannot reach the original downloader: an earlier add may have succeeded.
      const added = existing.torrentHash
        ? ((await client.list([existing.torrentHash]))[0] ?? null)
        : await client.findByTag(existing.lookupTag);
      if (added)
        return toResponse(
          await this.downloads.updateProgress(existing.id, withSyncTime(added, this.now(), existing.addedAt))
        );
    }
    const source = await this.sources.prepareLocal({
      ownerId, tmdbId, source: sourceProvider, releaseId, resource, locale,
    });
    const release = source.release;
    const claim = existing
      ? existing.status === 'missing'
        ? await aiStep('download.task.redownload', () => this.downloads.claimMissing(existing, provider, selected.downloaderInstanceId, selected.name),
            { downloadId: existing.id, provider })
        : await aiStep('download.task.retry', () => this.downloads.retry(existing.id))
      : await aiStep('download.task.claim', () => {
          return this.downloads.createSubmitting(ownerId, tmdbId, releaseId, provider, sourceProvider, selected.downloaderInstanceId, selected.name, undefined, resource);
        });
    let record = claim.record;
    // A different request or instance may have won the unique release claim.
    if (record.executionMode === 'remote' || record.provider !== provider || (record.downloaderInstanceId && record.downloaderInstanceId !== selected.downloaderInstanceId))
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'This release already belongs to another downloader');
    if (!claim.claimed) return toResponse(record);
    let torrentUrl: string;
    try {
      torrentUrl = await aiStep('download.torrent-url.resolve', () => source.torrentUrl());
    } catch (error) {
      await this.downloads.markFailed(record.id, 'MOVIE_DOWNLOAD_FAILED', this.now());
      if (error instanceof ResourceSiteError) throw error;
      throw new AppError(502, 'MOVIE_DOWNLOAD_FAILED', '', undefined, {
        cause: error,
      });
    }
    try {
      await this.notifications?.reserve(ownerId, record.id);
    } catch (error) {
      await this.downloads.markFailed(record.id, 'MOVIE_DOWNLOAD_FAILED', this.now());
      throw error;
    }
    try {
      let hash: string | undefined;
      try {
        hash = await aiStep(
          'download.downloader.submit',
          () => {
            return client.add(torrentUrl, record.lookupTag);
          },
          { provider, taskId: record.id }
        );
      } catch (submissionError) {
        // A response can be rejected after qBittorrent has accepted the torrent.
        // Reconcile by the task's unique tag before recording a failed submission.
        if (provider === 'qbittorrent') {
          let added: TorrentSnapshot | null = null;
          try {
            added = await aiStep(
              'download.downloader.reconcile',
              () => client.findByTag(record.lookupTag),
              { provider, taskId: record.id }
            );
          } catch (reconciliationError) {
            currentAiTrace()?.fail(reconciliationError, {
              stage: 'download.downloader.reconcile',
              provider,
              taskId: record.id,
            });
          }
          if (added) {
            record = await this.downloads.updateProgress(record.id, withSyncTime(added, this.now(), record.addedAt));
            await this.notifications?.submitted(ownerId, record.id);
            currentAiTrace()?.event('download.downloader.reconciled', {
              provider,
              taskId: record.id,
              outcome: 'found',
            });
            currentAiTrace()?.clearFailure();
            return toResponse(record);
          }
        }
        throw submissionError;
      }
      await this.notifications?.submitted(ownerId, record.id);
      if (hash) {
        record = await this.downloads.updateProgress(record.id, {
          torrentHash: hash,
          name: release.title,
          status: 'submitting',
          progress: 0,
          downloadedBytes: 0,
          totalBytes: release.sizeBytes ?? 0,
          downloadSpeed: 0,
          etaSeconds: 0,
          addedAt: this.now(),
          lastSyncedAt: this.now(),
        });
      }
      try {
        const added = hash ? (await client.list([hash]))[0] : await client.findByTag(record.lookupTag);
        if (added)
          record = await this.downloads.updateProgress(record.id, withSyncTime(added, this.now(), record.addedAt));
      } catch (error) {
        currentAiTrace()?.fail(error, { stage: 'download.progress.inspect', taskId: record.id });
        currentAiTrace()?.clearFailure();
        // The add succeeded. Later polling can refresh the hash or lookup tag.
      }
      return toResponse(record);
    } catch (error) {
      await this.downloads.markFailed(record.id, 'MOVIE_DOWNLOAD_FAILED', this.now());
      throw downloadClientError(provider, error, locale);
    }
  }

  async inspect(record: MovieDownloadRecord): Promise<MovieDownloadProgress | null> {
    if (record.executionMode === 'remote') {
      return {
        torrentHash: record.torrentHash ?? '',
        name: record.name ?? '',
        status: record.status,
        progress: record.progress,
        downloadedBytes: record.downloadedBytes ?? 0,
        totalBytes: record.totalBytes ?? 0,
        downloadSpeed: record.downloadSpeed ?? 0,
        etaSeconds: record.etaSeconds ?? 0,
        lastSyncedAt: record.lastSyncedAt ?? this.now(),
        ...(record.addedAt ? { addedAt: record.addedAt } : {}),
      };
    }
    if (!record.provider) throw new AppError(409, 'DOWNLOAD_NOT_CONFIGURED', '');
    const client = await this.clients.clientFor(record.ownerId, record.provider, record.downloaderInstanceId);
    const torrent = record.torrentHash
      ? (await client.list([record.torrentHash]))[0]
      : await client.findByTag(record.lookupTag);
    return torrent ? withSyncTime(torrent, this.now(), record.addedAt) : null;
  }

  async listAndSync(token: string | undefined, tmdbId: number | undefined): Promise<MovieDownloadListResponse> {
    const ownerId = await this.auth.requireOwnerId(token);
    const key = `${ownerId}:${tmdbId}`;
    const existing = this.syncs.get(key);
    const records = existing ? await existing : await this.runSharedSync(key, ownerId, tmdbId);
    return { items: records.map(toResponse) };
  }

  private async runSharedSync(key: string, ownerId: string, tmdbId: number | undefined): Promise<MovieDownloadRecord[]> {
    const operation = this.sync(ownerId, tmdbId);
    this.syncs.set(key, operation);
    try {
      return await operation;
    } finally {
      this.syncs.delete(key);
    }
  }

  private async sync(ownerId: string, tmdbId: number | undefined): Promise<MovieDownloadRecord[]> {
    let records = await aiStep('download.sync.records', () => this.downloads.listForMovie(ownerId, tmdbId));
    const syncable = records.filter((record) => {
      return (
        record.executionMode !== 'remote'
        && ['submitting', 'downloading', 'paused', 'seeding', 'failed', 'missing'].includes(record.status)
      );
    });
    if (!syncable.length) return records;
    const instanceKeys = [...new Set(syncable.map((record) => `${record.provider}:${record.downloaderInstanceId ?? ''}`))];
    for (const key of instanceKeys) {
      const owned = syncable.filter((record) => `${record.provider}:${record.downloaderInstanceId ?? ''}` === key);
      if (!owned.length) continue;
      const provider = owned[0]!.provider;
      if (!provider) continue;
      const downloaderInstanceId = owned[0]!.downloaderInstanceId;
      try {
        const client = await aiStep('download.sync.client', () => this.clients.clientFor(ownerId, provider, downloaderInstanceId), { provider, downloaderInstanceId });
        const hashes = owned.flatMap((record) => (record.torrentHash ? [record.torrentHash] : []));
        const torrents = hashes.length
          ? await aiStep(
              'download.sync.inspect',
              () => {
                return client.list(hashes);
              },
              { provider }
            )
          : [];
        const byHash = new Map(
          torrents.map((torrent) => {
            return [torrent.torrentHash.toLowerCase(), torrent];
          })
        );
        for (const record of owned) {
          const torrent = record.torrentHash
            ? (byHash.get(record.torrentHash.toLowerCase()) ?? null)
            : await client.findByTag(record.lookupTag);
          if (torrent)
            await this.downloads.updateProgress(record.id, withSyncTime(torrent, this.now(), record.addedAt));
          else if (record.torrentHash)
            await aiStep(
              'download.sync.missing',
              () => {
                return this.downloads.markMissing(record.id, this.now());
              },
              { taskId: record.id, provider }
            );
        }
      } catch (error) {
        currentAiTrace()?.fail(error, { provider, outcome: 'snapshot_preserved' });
        currentAiTrace()?.clearFailure();
        // Keep this provider's last snapshot; the other downloader can still sync.
      }
    }
    records = await this.downloads.listForMovie(ownerId, tmdbId);
    return records;
  }
}

function withSyncTime(snapshot: TorrentSnapshot, now: Date, addedAt?: Date): MovieDownloadProgress {
  return { ...snapshot, addedAt: addedAt ?? now, lastSyncedAt: now };
}
