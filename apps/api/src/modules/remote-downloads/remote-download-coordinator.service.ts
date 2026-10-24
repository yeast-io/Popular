import { Value } from '@sinclair/typebox/value';
import { GatewayDeviceStatusSchema } from '@movie-hub/contract';
import { randomUUID } from 'node:crypto';
import { AiTrace, withAiTrace, aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { REMOTE_DELIVERY_TTL_MS, REMOTE_QUEUE_RETRY_MS, REMOTE_QUEUE_WAIT_CODES } from './remote-download.policy.js';
import type { CommandRecord, DeviceStatus, DownloadRequest, PublicCommand, Session, AgentStatus } from '@movie-hub/contract';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { RpcCaller } from '@movie-hub/contract/socket-rpc';
import type { RemoteDownloadService } from './remote-download.service.js';
import { ensure, fingerprint, publicCommand } from './remote-download.domain.js';

export class RemoteDownloadCoordinator {
  constructor(readonly gateway: RpcCaller, readonly downloads: RemoteDownloadService) {}

  async enqueue(input: DownloadRequest): Promise<PublicCommand> {
    await aiStep('remote-queue.register', () => this.downloads.register(input, {
      ownerId: input.ownerId, deviceId: input.deviceId, authVersion: input.authVersion,
      deviceVersion: input.deviceVersion, sessionId: 'queued', instanceId: 'popular',
    }, true));
    await this.retry(input.commandId);
    return publicCommand(await this.downloads.get(input.commandId));
  }

  async retryQueued() {
    for await (const c of this.downloads.options.store.scanCommands({ retryBefore: this.downloads.now() })) {
      if (c.queueExpiresAt && c.queueExpiresAt > this.downloads.now()
        && ['accepted', 'delivered', 'received', 'failed'].includes(c.state)
        && (c.nextAttemptAt ?? 0) <= this.downloads.now()) {
        try {
          const diagnostics = this.downloads.options.diagnostics;
          const trace = new AiTrace(diagnostics?.logger, { correlationId: c.correlationId, commandId: c.commandId,
            retryAttempt: c.retryAttempt ?? 0 }, '', 'remote-queue.retry', diagnostics?.verbose ?? false);
          await withAiTrace(trace, () => trace.step('remote-queue.retry', () => this.retry(c.commandId)));
        } catch (error) {
          this.downloads.options.report(error, { stage: 'remote-queue.retry', correlationId: c.correlationId,
            commandId: c.commandId, retryAttempt: c.retryAttempt ?? 0 });
        }
      }
    }
  }

  private async retry(commandId: string) {
    let c = await this.downloads.get(commandId);
    if (!c.queueExpiresAt || c.queueExpiresAt <= this.downloads.now()
      || !['accepted', 'delivered', 'received', 'failed'].includes(c.state)
      || (c.nextAttemptAt ?? 0) > this.downloads.now()) return;
    // A CAS lease prevents simultaneous workers from starting another delivery attempt.
    const leased: CommandRecord = { ...c, revision: c.revision + 1,
      nextAttemptAt: this.downloads.now() + REMOTE_QUEUE_RETRY_MS, lastAttemptAt: this.downloads.now() };
    if (!await this.downloads.options.store.compareCommand(c, leased)) return;
    c = leased;
    try {
      const limit = await aiStep('remote-queue.resource-limit.read', () => this.downloads.options.store.resourceDownloadLimit(c, this.downloads.now()));
      if (limit) {
        await this.downloads.deferForResourceLimit(commandId, limit);
        return;
      }
      const status = await aiStep('remote-queue.gateway.status', () => this.gateway.call<DeviceStatus>(
        '__get_device_status__', { ownerId: c.ownerId, deviceId: c.deviceId,
          authVersion: c.authVersion, deviceVersion: c.deviceVersion }, c.correlationId));
      ensure(Value.Check(GatewayDeviceStatusSchema, status), 'INVALID_GATEWAY_STATUS');
      ensure(status.isAgentOnline && status.session, 'DEVICE_OFFLINE');
      ensure(status.isAgentDownloaderOnline && status.agentStatus?.configured && status.agentStatus.reachable,
        'DOWNLOADER_UNAVAILABLE');
      const target = status.agentStatus;
      ensure(!c.targetDownloader || (c.targetDownloader.instanceId === target.instanceId
        && c.targetDownloader.downloaderType === target.downloaderType), 'DOWNLOADER_INSTANCE_MISMATCH');
      await this.downloads.authorized(status.session);
      const previousErrorCode = c.lastErrorCode;
      c = await this.downloads.change(commandId, async (latest) => {
        if (!['accepted', 'delivered', 'received', 'failed'].includes(latest.state)) return latest;
        ensure(latest.queueExpiresAt! > this.downloads.now(), 'DELIVERY_EXPIRED');
        if (latest.executionId && latest.state !== 'failed') return latest;
        if (latest.deliverySessionId === status.session!.sessionId && latest.expiresAt > this.downloads.now()
          && latest.state !== 'failed') return latest;
        const { envelope: _envelope, executionId: _execution, grantSessionId: _session,
          grantExpiresAt: _grant, limitDetectedAt: _limit, executionDownloader: _downloader, result: _result, resultDigest: _digest, ...rest } = latest;
        return { ...rest, state: 'accepted', deliverySessionId: status.session!.sessionId,
          deliveryMessageId: randomUUID(), expiresAt: Math.min(latest.queueExpiresAt!, this.downloads.now() + REMOTE_DELIVERY_TTL_MS),
          targetDownloader: latest.targetDownloader ?? { downloaderType: target.downloaderType, instanceId: target.instanceId },
          retryAttempt: (latest.retryAttempt ?? 0) + 1, lastErrorCode: '', projected: false };
      });
      await this.downloads.project(c);
      if (c.executionId || !['accepted', 'delivered', 'received'].includes(c.state)) return;
      await aiStep('remote-queue.gateway.dispatch', () => this.gateway.call('__dispatch_download__', {
        commandId: c.commandId, downloadId: c.downloadId, ownerId: c.ownerId, deviceId: c.deviceId,
        authVersion: c.authVersion, deviceVersion: c.deviceVersion, source: c.source,
        resourceId: c.resourceId, correlationId: c.correlationId,
      }, c.correlationId));
      if (previousErrorCode && REMOTE_QUEUE_WAIT_CODES.includes(previousErrorCode) && !c.lastErrorCode) {
        this.downloads.options.diagnostics?.logger.info?.({
          stage: 'remote-queue.resumed', outcome: 'dispatched', correlationId: c.correlationId,
          commandId, retryAttempt: c.retryAttempt ?? 0, previousReason: previousErrorCode,
        }, 'remote-download');
      }
    } catch (error) {
      const waiting = error instanceof RpcError && error.effect === 'not_applied'
        && REMOTE_QUEUE_WAIT_CODES.includes(error.code);
      if (!waiting) {
        this.downloads.options.report(error, { stage: 'remote-queue.dispatch', correlationId: c.correlationId,
          commandId, retryAttempt: c.retryAttempt ?? 0 });
      }
      let previousReason: string | undefined;
      let waitChanged = false;
      const failed = await this.downloads.change(commandId, async (latest) => {
        waitChanged = false;
        if (latest.executionId || ['succeeded', 'duplicate', 'closed', 'cancelled'].includes(latest.state)) return latest;
        previousReason = latest.lastErrorCode;
        waitChanged = waiting && previousReason !== error.code;
        return { ...latest,
          state: error instanceof RpcError && error.effect === 'not_applied' && error.code !== 'DEVICE_OFFLINE' ? 'failed' : latest.state,
          lastErrorCode: error instanceof RpcError ? error.code : 'GATEWAY_UNAVAILABLE', projected: false };
      });
      await this.downloads.project(failed);
      if (waiting) {
        currentAiTrace()?.clearFailure();
        const diagnostics = this.downloads.options.diagnostics;
        if (!failed.executionId && ['accepted', 'delivered', 'received', 'failed'].includes(failed.state)
          && failed.lastErrorCode === error.code && (waitChanged || diagnostics?.verbose)) {
          diagnostics?.logger.info?.({
            stage: 'remote-queue.waiting', outcome: 'waiting', correlationId: failed.correlationId,
            commandId, retryAttempt: failed.retryAttempt ?? 0, reason: error.code,
            previousReason, nextAttemptAt: failed.nextAttemptAt,
          }, 'remote-download');
        }
      }
    }
  }

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
