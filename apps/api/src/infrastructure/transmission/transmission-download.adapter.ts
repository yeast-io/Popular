import type { TorrentInput } from '@movie-hub/contract';
import type { Locale, MovieDownloadStatus } from '@movie-hub/contract';
import type { DownloadClient, TorrentSnapshot } from '../../modules/downloads/movie-download-client.types.js';
import type { TransmissionCredential, TransmissionClientPort, TransmissionTorrent } from '../../modules/integrations/transmission.types.js';
import { currentAiTrace } from '../logging/ai-trace.js';
import { downloadClientOperation } from '../downloads/download-client-operation.adapter.js';

export class TransmissionDownloadAdapter implements DownloadClient {
  constructor(
    private readonly client: TransmissionClientPort,
    private readonly baseUrl: string,
    private readonly credential: TransmissionCredential,
    private readonly locale: Locale = 'en-US'
  ) {}

  async add(torrentUrl: TorrentInput, tag: string): Promise<string | undefined> {
    currentAiTrace()?.sensitive(typeof torrentUrl === 'string' ? torrentUrl : torrentUrl.metainfo);
    return downloadClientOperation('transmission', 'submit', this.locale, () =>
      this.client.addTorrent(this.baseUrl, this.credential, torrentUrl, tag));
  }

  async list(hashes: string[]): Promise<TorrentSnapshot[]> {
    return downloadClientOperation('transmission', 'list', this.locale, async () =>
      (await this.client.listTorrents(this.baseUrl, this.credential, hashes)).map(transmissionSnapshot));
  }

  async findByTag(tag: string): Promise<TorrentSnapshot | null> {
    return downloadClientOperation('transmission', 'find', this.locale, async () => {
      const torrent = await this.client.findByTag(this.baseUrl, this.credential, tag);
      return torrent ? transmissionSnapshot(torrent) : null;
    });
  }
}

function transmissionSnapshot(torrent: TransmissionTorrent): TorrentSnapshot {
  let status: MovieDownloadStatus;
  if (torrent.error) status = 'failed';
  else if (torrent.status === 5 || torrent.status === 6) status = 'seeding';
  else if (torrent.progress >= 1) status = 'completed';
  else if (torrent.status === 0) status = 'paused';
  else status = 'downloading';
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
