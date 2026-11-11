import type { TorrentInput } from '@movie-hub/contract';
import type { Locale, MovieDownloadStatus } from '@movie-hub/contract';
import type { DownloadClient, TorrentSnapshot } from '../../modules/downloads/movie-download-client.types.js';
import type { QBittorrentCredential, QBittorrentClientPort, QBittorrentTorrent } from '../../modules/integrations/qbittorrent.types.js';
import { currentAiTrace } from '../logging/ai-trace.js';
import { downloadClientOperation } from '../downloads/download-client-operation.adapter.js';

export class QBittorrentDownloadAdapter implements DownloadClient {
  constructor(
    private readonly client: QBittorrentClientPort,
    private readonly baseUrl: string,
    private readonly credential: QBittorrentCredential,
    private readonly locale: Locale = 'en-US'
  ) {}

  async add(torrentUrl: TorrentInput, tag: string): Promise<undefined> {
    currentAiTrace()?.sensitive(typeof torrentUrl === 'string' ? torrentUrl : torrentUrl.metainfo);
    return downloadClientOperation('qbittorrent', 'submit', this.locale, async () => {
      await this.client.addTorrent(this.baseUrl, this.credential, torrentUrl, tag);
      return undefined;
    });
  }

  async list(hashes: string[]): Promise<TorrentSnapshot[]> {
    return downloadClientOperation('qbittorrent', 'list', this.locale, async () =>
      (await this.client.listTorrents(this.baseUrl, this.credential, hashes)).map(qbittorrentSnapshot));
  }

  async findByTag(tag: string): Promise<TorrentSnapshot | null> {
    return downloadClientOperation('qbittorrent', 'find', this.locale, async () => {
      const torrent = await this.client.findByTag(this.baseUrl, this.credential, tag);
      return torrent ? qbittorrentSnapshot(torrent) : null;
    });
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
