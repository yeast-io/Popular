import type { DownloadProvider, DownloadProviderListResponse, MovieDownload, MovieDownloadListResponse, MovieDownloadStatus } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import type { IntegrationConfigStore } from '../integrations/integration.types.js';
import { integrationSecretContext } from '../integrations/integration.service.js';
import type { MTeamTorrentDownloader } from '../integrations/movie-resource-check.types.js';
import type { MovieResourceCheckService } from '../integrations/movie-resource-check.service.js';
import { decryptCredential, qbittorrentAppError } from '../integrations/qbittorrent-integration.service.js';
import type { QBittorrentClientPort, QBittorrentConfigStore, QBittorrentTorrent } from '../integrations/qbittorrent.types.js';
import { decryptCredential as decryptTransmissionCredential, transmissionAppError } from '../integrations/transmission-integration.service.js';
import type { TransmissionClientPort, TransmissionConfigStore, TransmissionTorrent } from '../integrations/transmission.types.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import type { MovieDownloadProgress, MovieDownloadRecord, MovieDownloadStore } from './movie-download.types.js';
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
    private readonly transmission?: { configs: TransmissionConfigStore; client: TransmissionClientPort },
  ) {}

  async providers(token: string | undefined): Promise<DownloadProviderListResponse> {
    return { providers: await this.providersFor(await this.auth.requireOwnerId(token)) };
  }

  private async providersFor(ownerId: string): Promise<DownloadProvider[]> {
    const [qb, tr] = await Promise.all([this.qbittorrentConfigs.find(ownerId), this.transmission?.configs.find(ownerId)]);
    return [...(qb ? ['qbittorrent' as const] : []), ...(tr ? ['transmission' as const] : [])];
  }

  async create(token: string | undefined, tmdbId: number, releaseId: string, requestedProvider?: DownloadProvider): Promise<MovieDownload> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = await this.downloads.findByRelease(ownerId, tmdbId, releaseId);
    if (existing && requestedProvider && existing.provider !== requestedProvider) {
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'This release already belongs to another downloader');
    }
    if (existing && !['failed', 'missing'].includes(existing.status)) return toResponse(existing);
    let provider = requestedProvider ?? existing?.provider;
    if (!provider) {
      const providers = await this.providersFor(ownerId);
      if (!providers.length) throw new AppError(409, 'DOWNLOAD_NOT_CONFIGURED', 'Configure a downloader before downloading');
      if (providers.length !== 1) throw new AppError(409, 'DOWNLOAD_PROVIDER_REQUIRED', 'Choose a downloader');
      provider = providers[0]!;
    }
    const client = await this.clientFor(ownerId, provider);
    if (existing) {
      // Do not retry if recovery cannot reach the original downloader: an earlier add may have succeeded.
      let added: TorrentSnapshot | null;
      try {
        added = existing.torrentHash
          ? (await client.list([existing.torrentHash]))[0] ?? null
          : await client.findByTag(existing.lookupTag);
      } catch (error) { throw providerError(provider, error); }
      if (added) return toResponse(await this.downloads.updateProgress(existing.id, withSyncTime(added, this.now(), existing.addedAt)));
    }
    const mteamConfig = await this.mteamConfigs.find(ownerId, 'mteam');
    if (!mteamConfig) throw new AppError(409, 'MTEAM_NOT_CONFIGURED', 'Configure M-Team before downloading');
    const releaseList = await this.resources.listReleases(ownerId, tmdbId);
    const release = releaseList.releases.find(release => release.id === releaseId);
    if (!release) throw new AppError(404, 'NOT_FOUND', 'The selected M-Team release is no longer available');
    const claim = existing
      ? await this.downloads.retry(existing.id)
      : await this.downloads.createSubmitting(ownerId, tmdbId, releaseId, provider);
    let record = claim.record;
    // A different request or instance may have won the unique release claim.
    if (record.provider !== provider) throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', 'This release already belongs to another downloader');
    if (!claim.claimed) return toResponse(record);
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
      const hash = await client.add(torrent, record.lookupTag);
      if (hash) {
        record = await this.downloads.updateProgress(record.id, {
          torrentHash: hash, name: release.title, status: 'submitting', progress: 0,
          downloadedBytes: 0, totalBytes: release.sizeBytes ?? 0, downloadSpeed: 0, etaSeconds: 0,
          addedAt: this.now(), lastSyncedAt: this.now(),
        });
      }
      try {
        const added = hash ? (await client.list([hash]))[0] : await client.findByTag(record.lookupTag);
        if (added) record = await this.downloads.updateProgress(record.id, withSyncTime(added, this.now(), record.addedAt));
      } catch {
        // The add succeeded. Later polling can refresh the hash or lookup tag.
      }
      return toResponse(record);
    } catch (error) {
      await this.downloads.markFailed(record.id, 'MOVIE_DOWNLOAD_FAILED', this.now());
      throw providerError(provider, error);
    }
  }

  private async clientFor(ownerId: string, provider: DownloadProvider): Promise<DownloadClient> {
    if (provider === 'transmission') {
      const config = await this.transmission?.configs.find(ownerId);
      if (!config || !this.transmission) throw new AppError(409, 'TRANSMISSION_NOT_CONFIGURED', 'Configure Transmission before downloading');
      const credential = decryptTransmissionCredential(config, this.secrets);
      const client = this.transmission.client;
      return {
        add: (torrent, tag) => client.addTorrent(config.baseUrl, credential, torrent, tag),
        list: async hashes => (await client.listTorrents(config.baseUrl, credential, hashes)).map(transmissionSnapshot),
        findByTag: async tag => {
          const torrent = await client.findByTag(config.baseUrl, credential, tag);
          return torrent ? transmissionSnapshot(torrent) : null;
        },
      };
    }
    const config = await this.qbittorrentConfigs.find(ownerId);
    if (!config) throw new AppError(409, 'QBITTORRENT_NOT_CONFIGURED', 'Configure qBittorrent before downloading');
    const credential = decryptCredential(config, this.secrets);
    return {
      add: async (torrent, tag) => { await this.qbittorrent.addTorrent(config.baseUrl, credential, torrent, tag); return undefined; },
      list: async hashes => (await this.qbittorrent.listTorrents(config.baseUrl, credential, hashes)).map(qbittorrentSnapshot),
      findByTag: async tag => {
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
    try { return await operation; } finally { this.syncs.delete(key); }
  }

  private async sync(ownerId: string, tmdbId: number): Promise<MovieDownloadRecord[]> {
    let records = await this.downloads.listForMovie(ownerId, tmdbId);
    const syncable = records.filter((record) => (
      ['submitting', 'downloading', 'paused', 'seeding', 'failed', 'missing'].includes(record.status)
    ));
    if (!syncable.length) return records;
    for (const provider of ['qbittorrent', 'transmission'] as const) {
      const owned = syncable.filter(record => record.provider === provider);
      if (!owned.length) continue;
      try {
        const client = await this.clientFor(ownerId, provider);
        const hashes = owned.flatMap(record => record.torrentHash ? [record.torrentHash] : []);
        const torrents = hashes.length ? await client.list(hashes) : [];
        const byHash = new Map(torrents.map(torrent => [torrent.torrentHash.toLowerCase(), torrent]));
        for (const record of owned) {
          const torrent = record.torrentHash
            ? byHash.get(record.torrentHash.toLowerCase()) ?? null
            : await client.findByTag(record.lookupTag);
          if (torrent) await this.downloads.updateProgress(record.id, withSyncTime(torrent, this.now(), record.addedAt));
          else if (record.torrentHash) await this.downloads.markMissing(record.id, this.now());
        }
      } catch {
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
    sourceProvider: 'mteam',
    sourceReleaseId: record.sourceReleaseId,
    provider: record.provider,
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

type TorrentSnapshot = Omit<MovieDownloadProgress, 'addedAt' | 'lastSyncedAt'>;

interface DownloadClient {
  add(torrent: Uint8Array, tag: string): Promise<string | undefined>;
  list(hashes: string[]): Promise<TorrentSnapshot[]>;
  findByTag(tag: string): Promise<TorrentSnapshot | null>;
}

function transmissionSnapshot(torrent: TransmissionTorrent): TorrentSnapshot {
  const status: MovieDownloadStatus = torrent.error ? 'failed'
    : torrent.status === 5 || torrent.status === 6 ? 'seeding'
    : torrent.progress >= 1 ? 'completed'
    : torrent.status === 0 ? 'paused' : 'downloading';
  return {
    torrentHash: torrent.hash, name: torrent.name, status, progress: torrent.progress * 100,
    downloadedBytes: torrent.downloadedBytes, totalBytes: torrent.totalBytes,
    downloadSpeed: torrent.downloadSpeed, etaSeconds: torrent.etaSeconds,
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
