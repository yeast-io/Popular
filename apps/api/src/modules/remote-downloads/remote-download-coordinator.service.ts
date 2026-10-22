import type { DownloadRequest, PublicCommand, Session, AgentStatus } from '@movie-hub/contract';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { RpcCaller } from '@movie-hub/contract/socket-rpc';
import type { RemoteDownloadService } from './remote-download.service.js';
import { ensure, fingerprint, publicCommand } from './remote-download.domain.js';

export class RemoteDownloadCoordinator {
  constructor(readonly gateway: RpcCaller, readonly downloads: RemoteDownloadService) {}

  async dispatch(input: DownloadRequest): Promise<PublicCommand> {
    const existing = await this.downloads.options.store.command(input.commandId);
    if (existing) {
      ensure(existing.ownerId === input.ownerId && existing.digest === fingerprint(input), 'IDEMPOTENCY_CONFLICT');
      return publicCommand(existing);
    }
    const status = await this.gateway.call<{ online: boolean; session?: Session; agentStatus?: AgentStatus }>(
      '__get_device_status__',
      {
        ownerId: input.ownerId,
        deviceId: input.deviceId,
        authVersion: input.authVersion,
        deviceVersion: input.deviceVersion,
      },
      input.correlationId
    );
    ensure(status.online && status.session, 'DEVICE_OFFLINE');
    ensure(status.agentStatus?.configured && status.agentStatus.reachable, 'DOWNLOADER_UNAVAILABLE');
    const c = await this.downloads.register(input, status.session);
    if (c.state !== 'accepted' || c.expiresAt <= this.downloads.now()) return publicCommand(c);
    try {
      return await this.gateway.call<PublicCommand>(
        '__dispatch_download__',
        input,
        input.correlationId,
        input.commandId
      );
    } catch (error) {
      if (error instanceof RpcError && error.effect === 'not_applied')
        await this.downloads.rejectDispatch(input.commandId);
      throw error;
    }
  }

  async query(commandId: string, ownerId: string) {
    const c = await this.downloads.get(commandId);
    ensure(c.ownerId === ownerId, 'COMMAND_OWNERSHIP_MISMATCH');
    return publicCommand(c);
  }

  async close(commandId: string, ownerId: string, closeId: string) {
    const result = await this.downloads.close(commandId, ownerId, closeId);
    const c = await this.downloads.get(commandId);
    try {
      await this.gateway.call(
        '__command_closed__',
        {
          eventId: closeId,
          commandId,
          ownerId,
          deviceId: c.deviceId,
          authVersion: c.authVersion,
          deviceVersion: c.deviceVersion,
        },
        c.correlationId,
        closeId
      );
    } catch (error) {
      this.downloads.options.report(error, {
        stage: 'remote-download.close-notify',
        correlationId: c.correlationId,
        commandId,
      });
    }
    return result;
  }
}
