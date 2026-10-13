import type { MovieDownload, MovieDownloadListResponse, MovieDownloadStatus } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import type { IntegrationConfigStore } from '../integrations/integration.types.js';
import { integrationSecretContext } from '../integrations/integration.service.js';
import type { MTeamTorrentDownloader } from '../integrations/movie-resource-check.types.js';
import type { MovieResourceCheckService } from '../integrations/movie-resource-check.service.js';
import { decryptCredential, qbittorrentAppError } from '../integrations/qbittorrent-integration.service.js';
import type { QBittorrentClientPort, QBittorrentConfigStore, QBittorrentTorrent } from '../integrations/qbittorrent.types.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import type { MovieDownloadRecord, MovieDownloadStore } from './movie-download.types.js';
import { userExternalRequestContext } from '../external-usage/external-usage.types.js';

export class MovieDownloadService {
  private readonly syncs = new Map<string, Promise<MovieDownloadRecord[]>>();

  constructor(
    private readonly auth: AuthService,
    private readonly downloads: MovieDownloadStore,
    private readonly qbittorrentConfigs: QBittorrentConfigStore,
    private readonly mteamConfigs: IntegrationConfigStore,
    private readonly secrets: SecretCrypto,
    private readonly qbittorrent: QBittorrentClientPort,
    private readonly mteam: MTeamTorrentDownloader,
    private readonly resources: Pick<MovieResourceCheckService, 'listReleases'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async configured(token: string | undefined): Promise<boolean> {
    return Boolean(await this.qbittorrentConfigs.find(await this.auth.requireOwnerId(token)));
  }

  async create(token: string | undefined, tmdbId: number, releaseId: string): Promise<MovieDownload> {
    const ownerId = await this.auth.requireOwnerId(token);
    const qbConfig = await this.qbittorrentConfigs.find(ownerId);
    if (!qbConfig) throw new AppError(409, 'QBITTORRENT_NOT_CONFIGURED', 'Configure qBittorrent before downloading');
    const mteamConfig = await this.mteamConfigs.find(ownerId, 'mteam');
    if (!mteamConfig) throw new AppError(409, 'MTEAM_NOT_CONFIGURED', 'Configure M-Team before downloading');

    const existing = await this.downloads.findByRelease(ownerId, tmdbId, releaseId);
    if (existing && !['failed', 'missing'].includes(existing.status)) return toResponse(existing);

    const credential = decryptCredential(qbConfig, this.secrets);
    if (existing) {
      try {
        const added = await this.qbittorrent.findByTag(qbConfig.baseUrl, credential, existing.lookupTag);
        if (added) {
          return toResponse(await this.downloads.updateProgress(
            existing.id,
            progressOf(added, this.now(), existing.addedAt),
          ));
        }
      } catch {
        // Recovery is best-effort. If the status lookup fails, continue with the normal retry flow.
      }
    }

    const releaseList = await this.resources.listReleases(ownerId, tmdbId);
    if (!releaseList.releases.some((release) => release.id === releaseId)) {
      throw new AppError(404, 'NOT_FOUND', 'The selected M-Team release is no longer available');
    }

    let record = existing ? await this.downloads.retry(existing.id) : await this.downloads.createSubmitting(ownerId, tmdbId, releaseId);
    let torrent: Uint8Array;
    try {
      torrent = await this.mteam.downloadTorrent(
        mteamConfig.baseUrl,
        this.secrets.decrypt(mteamConfig.encryptedApiKey, integrationSecretContext(ownerId, 'mteam')),
        releaseId,
        userExternalRequestContext(ownerId, 'api_request'),
      );
    } catch (error) {
      await this.downloads.markFailed(record.id, 'MOVIE_DOWNLOAD_FAILED', this.now());
      throw new AppError(502, 'MOVIE_DOWNLOAD_FAILED', 'Could not retrieve the selected M-Team release', undefined, { cause: error });
    }
    try {
      await this.qbittorrent.addTorrent(qbConfig.baseUrl, credential, torrent, record.lookupTag);
      try {
        const added = await this.qbittorrent.findByTag(qbConfig.baseUrl, credential, record.lookupTag);
        if (added) record = await this.downloads.updateProgress(record.id, progressOf(added, this.now(), record.addedAt));
      } catch {
        // The add succeeded. The on-demand status poll can resolve the hash later by the unique tag.
      }
      return toResponse(record);
    } catch (error) {
      await this.downloads.markFailed(record.id, 'MOVIE_DOWNLOAD_FAILED', this.now());
      if (error instanceof AppError) throw error;
      throw qbittorrentAppError(error, 'Could not add the selected release to qBittorrent');
    }
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
    try { return await operation; } finally { this.syncs.delete(key); }
  }

  private async sync(ownerId: string, tmdbId: number): Promise<MovieDownloadRecord[]> {
    let records = await this.downloads.listForMovie(ownerId, tmdbId);
    const syncable = records.filter((record) => (
      ['submitting', 'downloading', 'paused', 'seeding', 'failed', 'missing'].includes(record.status)
    ));
    if (!syncable.length) return records;
    const config = await this.qbittorrentConfigs.find(ownerId);
    if (!config) return records;
    try {
      const credential = decryptCredential(config, this.secrets);
      const hashed = syncable.filter((record) => record.torrentHash);
      const torrents = hashed.length
        ? await this.qbittorrent.listTorrents(config.baseUrl, credential, hashed.flatMap((record) => record.torrentHash ? [record.torrentHash] : []))
        : [];
      const byHash = new Map(torrents.map((torrent) => [torrent.hash.toLowerCase(), torrent]));
      for (const record of syncable) {
        const torrent = record.torrentHash
          ? byHash.get(record.torrentHash.toLowerCase()) ?? null
          : await this.qbittorrent.findByTag(config.baseUrl, credential, record.lookupTag);
        if (torrent) await this.downloads.updateProgress(record.id, progressOf(torrent, this.now(), record.addedAt));
        else if (record.torrentHash) await this.downloads.markMissing(record.id, this.now());
      }
      records = await this.downloads.listForMovie(ownerId, tmdbId);
    } catch {
      // Preserve the last known snapshot. A transient status refresh failure is not a failed download.
    }
    return records;
  }
}

function progressOf(torrent: QBittorrentTorrent, syncedAt: Date, addedAt?: Date) {
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
    addedAt: addedAt ?? syncedAt,
    lastSyncedAt: syncedAt,
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
    sourceProvider: 'mteam',
    sourceReleaseId: record.sourceReleaseId,
    provider: 'qbittorrent',
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
