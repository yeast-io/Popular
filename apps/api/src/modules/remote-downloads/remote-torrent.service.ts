import type { CommandRecord } from '@movie-hub/contract';
import type { DownloadSourceService } from '../downloads/download-source.service.js';
import type { RemoteDownloadSource, RemoteTorrentResult } from './remote-download.types.js';
import { readTorrentMetadata } from './torrent-metadata.service.js';

export class RemoteTorrentService {
  constructor(
    private readonly sources: Pick<DownloadSourceService, 'resolveRemote'>,
    private readonly metadata: typeof readTorrentMetadata = readTorrentMetadata
  ) {}

  async resolve(
    command: Pick<CommandRecord, 'ownerId' | 'source' | 'resourceId'>,
    download: Pick<RemoteDownloadSource, 'tmdbId'>
  ): Promise<RemoteTorrentResult> {
    const url = await this.sources.resolveRemote({
      ownerId: command.ownerId, tmdbId: download.tmdbId, source: command.source, releaseId: command.resourceId,
    });
    return { url, torrentHash: await this.metadata(url, { source: command.source }) };
  }
}
