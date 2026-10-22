import { siteAccountIdentityPending } from '../resource-sites/site-account.errors.js';
import type { MovieSiteResourcesService } from '../integrations/movie-site-resources.service.js';
import type { ResourceSiteService } from '../resource-sites/resource-site.service.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import type { IntegrationPreferencesService } from '../integrations/integration-preferences.service.js';
import type { TorrentSnapshot, DownloadClient } from './movie-download-client.types.js';
import type {
  DownloadProvider,
  DownloaderChoice,
  DownloadSource,
  DownloadProviderListResponse,
  MovieDownload,
  MovieDownloadListResponse,
  MovieDownloadStatus,
} from '@movie-hub/contract';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import type { IntegrationConfigStore } from '../integrations/integration.types.js';
import { integrationSecretContext } from '../integrations/integration.service.js';
import type { MTeamTorrentUrlProvider } from '../integrations/movie-resource-check.types.js';
import type { MovieResourceCheckService } from '../integrations/movie-resource-check.service.js';
import { decryptCredential, normalizeQBittorrentBaseUrl, qbittorrentAppError } from '../integrations/qbittorrent-integration.service.js';
import type {
  QBittorrentClientPort,
  QBittorrentConfigStore,
  QBittorrentTorrent,
} from '../integrations/qbittorrent.types.js';
import {
  decryptCredential as decryptTransmissionCredential,
  normalizeTransmissionBaseUrl,
  transmissionAppError,
} from '../integrations/transmission-integration.service.js';
import type {
  TransmissionClientPort,
  TransmissionConfigStore,
  TransmissionTorrent,
} from '../integrations/transmission.types.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import type { MovieDownloadProgress, MovieDownloadRecord, MovieDownloadStore } from './movie-download.types.js';
import type { NotificationService } from '../notifications/notification.service.js';
import { userExternalRequestContext } from '../external-usage/external-usage.domain.js';

export class MovieDownloadService {
  preferences?: Pick<IntegrationPreferencesService, 'get'>;
  private readonly syncs = new Map<string, Promise<MovieDownloadRecord[]>>();

  constructor(
    private readonly auth: AuthService,
    private readonly downloads: MovieDownloadStore,
    private readonly qbittorrentConfigs: QBittorrentConfigStore,
    private readonly mteamConfigs: IntegrationConfigStore,
    private readonly secrets: SecretCrypto,
    private readonly qbittorrent: QBittorrentClientPort,
    private readonly mteam: MTeamTorrentUrlProvider,
    private readonly resources: Pick<MovieResourceCheckService, 'listReleases'>,
    private readonly now: () => Date = () => new Date(),
    private readonly transmission?: { configs: TransmissionConfigStore; client: TransmissionClientPort },
    private readonly notifications?: Pick<NotificationService, 'reserve' | 'submitted'>,
    private readonly siteDownloads?: {
      resources: Pick<MovieSiteResourcesService, 'releaseForDownload'>;
      sites: Pick<ResourceSiteService, 'torrentUrl'>;
    }
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
    const [qb, tr] = await Promise.all([
      this.qbittorrentConfigs.list?.(ownerId) ?? this.qbittorrentConfigs.find(ownerId).then((record) => record ? [record] : []),
      this.transmission?.configs.list?.(ownerId) ?? this.transmission?.configs.find(ownerId).then((record) => record ? [record] : []) ?? [],
    ]);
    return [
      ...qb.map((record) => ({ downloaderInstanceId: record.downloaderInstanceId ?? 'qbittorrent', provider: 'qbittorrent' as const, name: record.name ?? 'qBittorrent' })),
      ...tr.map((record) => ({ downloaderInstanceId: record.downloaderInstanceId ?? 'transmission', provider: 'transmission' as const, name: record.name ?? 'Transmission' })),
    ];
  }

  async create(
    token: string | undefined,
    tmdbId: number,
    releaseId: string,
    requestedProvider?: DownloadProvider,
    sourceProvider: DownloadSource = 'mteam',
    requestedInstanceId?: string
  ): Promise<MovieDownload> {
    return this.createForOwner(
      await this.auth.requireOwnerId(token),
      tmdbId,
      releaseId,
      requestedProvider,
      sourceProvider,
      requestedInstanceId
    );
  }

  /** Internal entry: owner identity must come from a verified channel binding or authenticated conversation. */
  async createForOwner(
    ownerId: string,
    tmdbId: number,
    releaseId: string,
    requestedProvider?: DownloadProvider,
    sourceProvider: DownloadSource = 'mteam',
    requestedInstanceId?: string
  ): Promise<MovieDownload> {
    const existing = await this.downloads.findByRelease(ownerId, tmdbId, releaseId, sourceProvider);
    if (existing?.executionMode === 'remote') return toResponse(existing);
    if (existing && requestedProvider && existing.provider !== requestedProvider) {
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'This release already belongs to another downloader');
    }
    if (existing?.downloaderInstanceId && requestedInstanceId && existing.downloaderInstanceId !== requestedInstanceId)
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'This release already belongs to another downloader');
    if (existing && !['failed', 'missing'].includes(existing.status)) return toResponse(existing);
    const choices = await this.instancesFor(ownerId);
    const pinnedId = requestedInstanceId ?? existing?.downloaderInstanceId;
    const selectedType = requestedProvider ?? existing?.provider;
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
    const client = await aiStep('download.client.load', () => this.clientFor(ownerId, provider, selected.downloaderInstanceId));
    if (existing) {
      // Do not retry if recovery cannot reach the original downloader: an earlier add may have succeeded.
      let added: TorrentSnapshot | null;
      try {
        added = existing.torrentHash
          ? ((await client.list([existing.torrentHash]))[0] ?? null)
          : await client.findByTag(existing.lookupTag);
      } catch (error) {
        throw providerError(provider, error);
      }
      if (added)
        return toResponse(
          await this.downloads.updateProgress(existing.id, withSyncTime(added, this.now(), existing.addedAt))
        );
    }
    const mteamConfig = sourceProvider === 'mteam' ? await this.mteamConfigs.find(ownerId, 'mteam') : null;
    if (sourceProvider === 'mteam' && !mteamConfig)
      throw new AppError(409, 'MTEAM_NOT_CONFIGURED', 'Configure M-Team before downloading');
    if (sourceProvider === 'mteam' && !mteamConfig?.externalUserId) throw siteAccountIdentityPending();
    if (sourceProvider === 'hdarea' && !this.siteDownloads) throw new ResourceSiteError('notConfigured');
    const release = await aiStep(
      'download.resources.validate',
      async () => {
        if (sourceProvider === 'hdarea')
          return this.siteDownloads!.resources.releaseForDownload(ownerId, tmdbId, sourceProvider, releaseId);
        const list = await this.resources.listReleases(ownerId, tmdbId);
        const selected = list.releases.find((release) => release.id === releaseId);
        if (!selected) throw new AppError(404, 'NOT_FOUND', '');
        return selected;
      },
      { sourceProvider, releaseId }
    );
    const claim = existing
      ? await aiStep('download.task.retry', () => this.downloads.retry(existing.id))
      : await aiStep('download.task.claim', () => {
          return this.downloads.createSubmitting(ownerId, tmdbId, releaseId, provider, sourceProvider, selected.downloaderInstanceId, selected.name);
        });
    let record = claim.record;
    // A different request or instance may have won the unique release claim.
    if (record.provider !== provider || (record.downloaderInstanceId && record.downloaderInstanceId !== selected.downloaderInstanceId))
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'This release already belongs to another downloader');
    if (!claim.claimed) return toResponse(record);
    let torrentUrl: string;
    try {
      torrentUrl = await aiStep('download.torrent-url.resolve', () => {
        if (sourceProvider === 'hdarea')
          return this.siteDownloads!.sites.torrentUrl(ownerId, sourceProvider, releaseId);
        return this.mteam.torrentUrl(
          mteamConfig!.baseUrl,
          this.secrets.decrypt(mteamConfig!.encryptedApiKey, integrationSecretContext(ownerId, 'mteam')),
          releaseId,
          userExternalRequestContext(ownerId, 'api_request')
        );
      });
      currentAiTrace()?.sensitive(torrentUrl);
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
      throw providerError(provider, error);
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
    const client = await this.clientFor(record.ownerId, record.provider, record.downloaderInstanceId);
    const torrent = record.torrentHash
      ? (await client.list([record.torrentHash]))[0]
      : await client.findByTag(record.lookupTag);
    return torrent ? withSyncTime(torrent, this.now(), record.addedAt) : null;
  }

  private async clientFor(ownerId: string, provider: DownloadProvider, downloaderInstanceId?: string): Promise<DownloadClient> {
    if (!downloaderInstanceId && (await this.instancesFor(ownerId)).filter((choice) => choice.provider === provider).length > 1)
      throw new AppError(409, 'DOWNLOAD_PROVIDER_REQUIRED', 'Historical download has no pinned downloader instance');
    if (provider === 'transmission') {
      const config = await this.transmission?.configs.find(ownerId, downloaderInstanceId);
      if (!config || !this.transmission)
        throw new AppError(409, 'TRANSMISSION_NOT_CONFIGURED', 'Configure Transmission before downloading');
      normalizeTransmissionBaseUrl(config.baseUrl);
      const credential = decryptTransmissionCredential(config, this.secrets);
      const client = this.transmission.client;
      return {
        add: (torrentUrl, tag) => client.addTorrent(config.baseUrl, credential, torrentUrl, tag),
        list: async (hashes) => {
          return (await client.listTorrents(config.baseUrl, credential, hashes)).map(transmissionSnapshot);
        },
        findByTag: async (tag) => {
          const torrent = await client.findByTag(config.baseUrl, credential, tag);
          return torrent ? transmissionSnapshot(torrent) : null;
        },
      };
    }
    const config = await this.qbittorrentConfigs.find(ownerId, downloaderInstanceId);
    if (!config) throw new AppError(409, 'QBITTORRENT_NOT_CONFIGURED', 'Configure qBittorrent before downloading');
    normalizeQBittorrentBaseUrl(config.baseUrl);
    const credential = decryptCredential(config, this.secrets);
    return {
      add: async (torrentUrl, tag) => {
        await this.qbittorrent.addTorrent(config.baseUrl, credential, torrentUrl, tag);
        return undefined;
      },
      list: async (hashes) => {
        return (await this.qbittorrent.listTorrents(config.baseUrl, credential, hashes)).map(qbittorrentSnapshot);
      },
      findByTag: async (tag) => {
        const torrent = await this.qbittorrent.findByTag(config.baseUrl, credential, tag);
        return torrent ? qbittorrentSnapshot(torrent) : null;
      },
    };
  }

  async listAndSync(token: string | undefined, tmdbId: number): Promise<MovieDownloadListResponse> {
    const ownerId = await this.auth.requireOwnerId(token);
    const key = `${ownerId}:${tmdbId}`;
    const existing = this.syncs.get(key);
    const records = existing ? await existing : await this.runSharedSync(key, ownerId, tmdbId);
    return { items: records.map(toResponse) };
  }

  private async runSharedSync(key: string, ownerId: string, tmdbId: number): Promise<MovieDownloadRecord[]> {
    const operation = this.sync(ownerId, tmdbId);
    this.syncs.set(key, operation);
    try {
      return await operation;
    } finally {
      this.syncs.delete(key);
    }
  }

  private async sync(ownerId: string, tmdbId: number): Promise<MovieDownloadRecord[]> {
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
      const downloaderInstanceId = owned[0]!.downloaderInstanceId;
      try {
        const client = await aiStep('download.sync.client', () => this.clientFor(ownerId, provider, downloaderInstanceId), { provider, downloaderInstanceId });
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

function qbittorrentSnapshot(torrent: QBittorrentTorrent): TorrentSnapshot {
  const status = statusOf(torrent);
  return {
    torrentHash: torrent.hash,
    name: torrent.name,
    status,
    progress: Math.min(100, Math.max(0, torrent.progress * 100)),
    downloadedBytes: torrent.downloadedBytes,
    totalBytes: torrent.totalBytes,
    downloadSpeed: torrent.downloadSpeed,
    etaSeconds: torrent.etaSeconds,
  };
}

function statusOf(torrent: QBittorrentTorrent): MovieDownloadStatus {
  if (/error|missing/i.test(torrent.state)) return 'failed';
  if (/uploading|stalledUP|forcedUP|queuedUP|checkingUP/i.test(torrent.state)) return 'seeding';
  if (torrent.progress >= 1 || /complete/i.test(torrent.state)) return 'completed';
  if (/paused|stopped/i.test(torrent.state)) return 'paused';
  return 'downloading';
}

function toResponse(record: MovieDownloadRecord): MovieDownload {
  return {
    id: record.id,
    tmdbId: record.tmdbId,
    sourceProvider: record.sourceProvider,
    sourceReleaseId: record.sourceReleaseId,
    provider: record.provider,
    ...(record.downloaderInstanceId ? { downloaderInstanceId: record.downloaderInstanceId } : {}),
    ...(record.downloaderName ? { downloaderName: record.downloaderName } : {}),
    status: record.status,
    progress: record.progress,
    ...(record.downloadedBytes !== undefined ? { downloadedBytes: record.downloadedBytes } : {}),
    ...(record.totalBytes !== undefined ? { totalBytes: record.totalBytes } : {}),
    ...(record.downloadSpeed !== undefined ? { downloadSpeed: record.downloadSpeed } : {}),
    ...(record.etaSeconds !== undefined ? { etaSeconds: record.etaSeconds } : {}),
    ...(record.lastErrorCode ? { lastErrorCode: record.lastErrorCode } : {}),
    ...(record.addedAt ? { addedAt: record.addedAt.toISOString() } : {}),
    ...(record.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt.toISOString() } : {}),
  };
}

function transmissionSnapshot(torrent: TransmissionTorrent): TorrentSnapshot {
  const status: MovieDownloadStatus = torrent.error
    ? 'failed'
    : torrent.status === 5 || torrent.status === 6
      ? 'seeding'
      : torrent.progress >= 1
        ? 'completed'
        : torrent.status === 0
          ? 'paused'
          : 'downloading';
  return {
    torrentHash: torrent.hash,
    name: torrent.name,
    status,
    progress: torrent.progress * 100,
    downloadedBytes: torrent.downloadedBytes,
    totalBytes: torrent.totalBytes,
    downloadSpeed: torrent.downloadSpeed,
    etaSeconds: torrent.etaSeconds,
  };
}

function withSyncTime(snapshot: TorrentSnapshot, now: Date, addedAt?: Date): MovieDownloadProgress {
  return { ...snapshot, addedAt: addedAt ?? now, lastSyncedAt: now };
}

function providerError(provider: DownloadProvider, error: unknown): AppError {
  if (error instanceof AppError) return error;
  return provider === 'transmission'
    ? transmissionAppError(error, 'Could not access the Transmission download')
    : qbittorrentAppError(error, 'Could not access the qBittorrent download');
}
