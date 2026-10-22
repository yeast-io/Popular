import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { PopularRpcSchemas } from '@movie-hub/contract';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type {
  Authorization,
  Session,
  DeviceKeys,
  DownloadRequest,
  CommandRecord,
  AgentStatus,
  ResultPayload,
  StatusPayload,
  PreparedDelivery,
} from '@movie-hub/contract';
import { awaitingExecution, checkContext, ensure, fingerprint, publicCommand } from './remote-download.domain.js';
import type { RemoteDownloadServiceOptions } from './remote-download.types.js';

export class RemoteDownloadService {
  readonly now: () => number;

  constructor(readonly options: RemoteDownloadServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async authorized(context: Session): Promise<Authorization> {
    const a = await this.options.store.validate(context);
    ensure(
      a?.active
      && a.deviceId === context.deviceId
      && a.authVersion === context.authVersion
      && a.deviceVersion === context.deviceVersion
      && a.keys,
      'SESSION_REVOKED'
    );
    return a;
  }

  async get(commandId: string) {
    const c = await this.options.store.command(commandId);
    ensure(c, 'COMMAND_NOT_FOUND');
    return c;
  }

  async change(commandId: string, fn: (c: CommandRecord) => Promise<CommandRecord>) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const c = await this.get(commandId);
      const next = await fn(c);
      if (next === c) return c;
      next.revision = c.revision + 1;
      if (await this.options.store.compareCommand(c, next)) return next;
    }
    throw new RpcError('SERVICE_BUSY', 'not_applied');
  }

  async register(input: DownloadRequest, session: Session) {
    const existing = await this.options.store.command(input.commandId);
    if (existing) {
      ensure(existing.digest === fingerprint(input), 'IDEMPOTENCY_CONFLICT');
      return existing;
    }
    await this.authorized(session);
    ensure(
      input.ownerId === session.ownerId
      && input.deviceId === session.deviceId
      && input.authVersion === session.authVersion
      && input.deviceVersion === session.deviceVersion,
      'AUTHORIZATION_MISMATCH'
    );
    const d = await this.options.store.download(input);
    ensure(d?.executionMode === 'remote', 'DOWNLOAD_OWNERSHIP_MISMATCH');
    const c: CommandRecord = {
      ...input,
      digest: fingerprint(input),
      revision: 0,
      state: 'accepted',
      createdAt: this.now(),
      expiresAt: this.now() + 60_000,
      deliverySessionId: session.sessionId,
      deliveryMessageId: randomUUID(),
    };
    const created = await this.options.store.createCommand(c);
    ensure(created.digest === c.digest, 'IDEMPOTENCY_CONFLICT');
    return created;
  }

  async handle(command: string, payload: unknown): Promise<unknown> {
    const schema = PopularRpcSchemas[command as keyof typeof PopularRpcSchemas];
    ensure(schema && Value.Check(schema, payload), 'INVALID_REQUEST');
    const p = payload as Record<string, unknown>;
    if (command === '__resolve_client_authorization__') {
      const a = await this.options.store.authorization(p.keyDigest as string, p.deviceId as string | undefined);
      ensure(a?.active, 'INVALID_API_KEY');
      return a;
    }
    if (command === '__bind_device__') {
      const bound = await this.options.store.bind(
        p.keyDigest as string,
        p.authVersion as number,
        p.operationId as string,
        p.keys as DeviceKeys
      );
      ensure(bound?.active && bound.deviceId && bound.deviceVersion, 'DEVICE_BINDING_REJECTED');
      return bound;
    }
    const context = p.context as Session;
    const auth = await this.authorized(context);
    if (command === '__validate_session__') return auth;
    if (command === '__list_pending_deliveries__') {
      const pending: string[] = [];
      for await (const c of this.options.store.scanCommands({ deviceId: context.deviceId, pendingOnly: true })) {
        if (awaitingExecution(c) && c.deliverySessionId === context.sessionId && c.expiresAt > this.now())
          pending.push(c.commandId);
        if (pending.length >= 64) break;
      }
      return { commandIds: pending };
    }
    if (command === '__prepare_delivery__') return this.prepare(context, p.commandId as string);
    if (command === '__save_delivery__') {
      const c = await this.change(p.commandId as string, async (c) => {
        checkContext(c, context);
        await this.authorized(context);
        ensure(
          c.deliverySessionId === context.sessionId
          && c.deliveryMessageId === p.deliveryMessageId
          && c.expiresAt > this.now()
          && awaitingExecution(c),
          'DELIVERY_EXPIRED'
        );
        if (c.envelope) return c; // Concurrent encryption uses random IVs; retain the first immutable persisted envelope.
        ensure(c.torrentHash, 'TORRENT_HASH_REQUIRED');
        return { ...c, envelope: p.envelope as string, state: 'delivered' };
      });
      return c;
    }
    if (command === '__authorize_execution__') {
      const c = await this.change(p.commandId as string, async (c) => {
        checkContext(c, context);
        await this.authorized(context);
        const downloader = p.downloader as AgentStatus;
        ensure(downloader.configured && downloader.reachable, 'DOWNLOADER_UNAVAILABLE');
        const download = await this.options.store.download(c);
        ensure(download?.downloaderType === downloader.downloaderType, 'DOWNLOADER_TYPE_MISMATCH');
        if (c.executionId) {
          ensure(
            c.executionId === p.executionId
            && c.grantSessionId === context.sessionId
            && c.state === 'granted'
            && c.grantExpiresAt! > this.now(),
            'EXECUTION_ALREADY_AUTHORIZED'
          );
          return c;
        }
        ensure(
          c.state === 'received' && c.deliverySessionId === context.sessionId && c.expiresAt > this.now(),
          'EXECUTION_NOT_ALLOWED'
        );
        return {
          ...c,
          state: 'granted',
          executionId: p.executionId as string,
          grantSessionId: context.sessionId,
          grantExpiresAt: Math.min(c.expiresAt, this.now() + 30_000),
          executionDownloader: {
            downloaderType: downloader.downloaderType,
            instanceId: downloader.instanceId,
          },
        };
      });
      return { decision: 'granted', command: c };
    }
    if (command === '__recover_execution__') {
      const c = await this.get(p.commandId as string);
      checkContext(c, context);
      ensure(c.executionId === p.executionId, 'EXECUTION_MISMATCH');
      await this.project(c);
      return { ...publicCommand(c), mayExecute: false };
    }
    if (command === '__confirm_command_received__') {
      await this.remember(context, p);
      const c = await this.change(p.commandId as string, async (c) => {
        checkContext(c, context);
        await this.authorized(context);
        ensure(c.deliverySessionId === context.sessionId, 'DELIVERY_SESSION_EXPIRED');
        if (c.state === 'delivered' && c.expiresAt > this.now()) return { ...c, state: 'received' };
        ensure(c.state === 'received' || !!c.executionId, 'COMMAND_NOT_DELIVERED');
        return c;
      });
      return publicCommand(c);
    }
    if (command === '__record_command_result__') {
      await this.remember(context, p);
      const result = p.result as ResultPayload;
      const c = await this.change(result.commandId, async (c) => {
        checkContext(c, context);
        await this.authorized(context);
        ensure(c.executionId === result.executionId, 'EXECUTION_MISMATCH');
        if (result.outcome === 'succeeded')
          ensure(
            result.evidence
            && result.evidence.torrentHash === c.torrentHash
            && result.evidence.marker === `popular-${result.executionId}`
            && result.evidence.instanceId === c.executionDownloader?.instanceId
            && result.evidence.downloaderType === c.executionDownloader.downloaderType,
            'TASK_EVIDENCE_REQUIRED'
          );
        else ensure(!result.evidence, 'UNEXPECTED_TASK_EVIDENCE');
        ensure(
          await this.options.store.remember(
            `${c.commandId}:result:${result.executionId}:${result.outcome}`,
            fingerprint(result)
          ),
          'IDEMPOTENCY_CONFLICT'
        );
        if (c.resultDigest === fingerprint(result) || (result.outcome === 'unknown' && c.result)) return c;
        ensure(!c.result || c.result.outcome === 'unknown', 'RESULT_ALREADY_FINAL');
        return {
          ...c,
          state: c.state === 'closed' ? 'closed' : result.outcome,
          result,
          resultDigest: fingerprint(result),
          projected: false,
        };
      });
      await this.project(c);
      return { persisted: true, commandId: c.commandId, executionId: c.executionId, outcome: result.outcome };
    }
    if (command === '__record_download_status__') {
      await this.remember(context, p);
      const status = p.status as StatusPayload;
      const c = await this.get(status.commandId);
      checkContext(c, context);
      ensure(
        c.executionId === status.executionId
        && c.result?.outcome === 'succeeded'
        && fingerprint(c.result.evidence) === fingerprint(status.evidence),
        'DOWNLOAD_ASSOCIATION_MISMATCH'
      );
      ensure(
        await this.options.store.remember(
          `${c.commandId}:status:${status.executionId}:${status.sequence}`,
          fingerprint(status)
        ),
        'STATUS_SEQUENCE_CONFLICT'
      );
      await this.authorized(context);
      ensure((await this.options.store.applyStatus(c, status)) !== 'conflict', 'DOWNLOAD_ASSOCIATION_CONFLICT');
      return { persisted: true, commandId: c.commandId, executionId: c.executionId, sequence: status.sequence };
    }
    throw new RpcError('UNSUPPORTED_COMMAND', 'not_applied');
  }

  private async prepare(context: Session, commandId: string): Promise<PreparedDelivery> {
    let c = await this.get(commandId);
    checkContext(c, context);
    const auth = await this.authorized(context);
    ensure(
      c.deliverySessionId === context.sessionId && c.expiresAt > this.now() && awaitingExecution(c),
      'DELIVERY_EXPIRED'
    );
    if (c.envelope) return { command: c, keys: auth.keys! };
    const d = await this.options.store.download(c);
    ensure(d, 'DOWNLOAD_OWNERSHIP_MISMATCH');
    const torrent = await this.options.torrent(c, d);
    ensure(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(torrent.torrentHash), 'TORRENT_HASH_REQUIRED');
    const url = new URL(torrent.url);
    ensure(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'INVALID_TORRENT_URL');
    c = await this.change(commandId, async (latest) => {
      await this.authorized(context);
      checkContext(latest, context);
      ensure(
        awaitingExecution(latest) && latest.deliverySessionId === context.sessionId && latest.expiresAt > this.now(),
        'DELIVERY_EXPIRED'
      );
      ensure(!latest.torrentHash || latest.torrentHash === torrent.torrentHash, 'TORRENT_HASH_CONFLICT');
      return latest.torrentHash ? latest : { ...latest, torrentHash: torrent.torrentHash };
    });
    return { command: c, keys: auth.keys!, torrent };
  }

  private async remember(context: Session, p: Record<string, unknown>) {
    ensure(
      await this.options.store.remember(
        `${context.ownerId}:${context.deviceId}:${context.authVersion}:${context.deviceVersion}:message:${p.agentMessageId}`,
        p.agentDigest as string
      ),
      'MESSAGE_ID_CONFLICT'
    );
  }

  async project(c: CommandRecord) {
    if (c.projected || (!c.result && !['closed', 'expired', 'cancelled'].includes(c.state))) return;
    ensure(await this.options.store.projectResult(c), 'DOWNLOAD_ASSOCIATION_CONFLICT');
    await this.change(c.commandId, async (latest) => {
      return latest.resultDigest === c.resultDigest && latest.closeId === c.closeId && latest.state === c.state
        ? { ...latest, projected: true }
        : latest;
    });
  }

  async rejectDispatch(commandId: string) {
    const c = await this.change(commandId, async (c) => {
      return awaitingExecution(c) && !c.executionId ? { ...c, state: 'cancelled', projected: false } : c;
    });
    await this.project(c);
  }

  async close(commandId: string, ownerId: string, closeId: string) {
    const c = await this.change(commandId, async (c) => {
      ensure(c.ownerId === ownerId, 'COMMAND_OWNERSHIP_MISMATCH');
      if (c.closeId) {
        ensure(c.closeId === closeId, 'IDEMPOTENCY_CONFLICT');
        return c;
      }
      return { ...c, closeId, state: 'closed', projected: false };
    });
    await this.project(c);
    return publicCommand(c);
  }

  async sweep() {
    await this.options.store.recoverCommands();
    for await (const row of this.options.store.scanCommands({ pendingOnly: true })) {
      try {
        const c = await this.change(row.commandId, async (c) => {
          if (!awaitingExecution(c) && c.state !== 'granted') return c;
          const a = await this.options.store.validate({
            ownerId: c.ownerId,
            deviceId: c.deviceId,
            authVersion: c.authVersion,
            deviceVersion: c.deviceVersion,
            sessionId: c.deliverySessionId,
            instanceId: 'recovery',
          }
          );
          if (a?.active && (c.state === 'granted' ? c.grantExpiresAt! : c.expiresAt) > this.now()) return c;
          if (c.state === 'granted') {
            const result: ResultPayload = { commandId: c.commandId, executionId: c.executionId!, outcome: 'unknown' };
            return { ...c, state: 'unknown', result, resultDigest: fingerprint(result), projected: false };
          }
          return { ...c, state: a?.active ? 'expired' : 'cancelled', projected: false };
        });
        await this.project(c);
      } catch (error) {
        this.options.report(error, {
          stage: 'remote-download.recovery',
          correlationId: row.correlationId,
          commandId: row.commandId,
        });
      }
    }
  }
}
