import type { AgentResourceService } from '../agent-resources/agent-resource.service.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { CommandRecord } from '@movie-hub/contract';
import type { DownloadSourceService } from '../downloads/download-source.service.js';
import type { RemoteDownloadSource, RemoteTorrentResult } from './remote-download.types.js';
import { readTorrentMetadata } from './torrent-metadata.service.js';

export class RemoteTorrentService {
  agentResources?: AgentResourceService;

  constructor(
    private readonly sources: Pick<DownloadSourceService, 'resolveRemote'>,
    private readonly metadata: typeof readTorrentMetadata = readTorrentMetadata
  ) {}

  async resolve(
    command: Pick<CommandRecord, 'ownerId' | 'source' | 'resourceId'>
      & Partial<Pick<CommandRecord, 'commandId' | 'deviceId'>>,
    download: Pick<RemoteDownloadSource, 'tmdbId' | 'resourceExecution' | 'resourceCredentialVersion'>
  ): Promise<RemoteTorrentResult> {
    const selected = await this.agentResources?.device(command.ownerId);
    if ((download.resourceExecution === 'agent') !== !!selected) throw new ResourceSiteError('agentModeConflict');
    if (selected) {
      if (!command.commandId || command.deviceId !== selected || !download.resourceCredentialVersion)
        throw new ResourceSiteError('agentModeConflict');
      try {
        return await this.agentResources!.prepare(
          command.ownerId,
          command.source,
          command.resourceId,
          command.commandId,
          selected,
          download.resourceCredentialVersion
        );
      } catch (error) {
        if (error instanceof ResourceSiteError && error.reason === 'downloadLimited')
          throw new RpcError('RESOURCE_TORRENT_DAILY_LIMIT', 'not_applied');
        throw error;
      }
    }
    const url = await this.sources.resolveRemote({
      ownerId: command.ownerId,
      tmdbId: download.tmdbId,
      source: command.source,
      releaseId: command.resourceId,
    });
    return { url, torrentHash: await this.metadata(url, { source: command.source }) };
  }
}
