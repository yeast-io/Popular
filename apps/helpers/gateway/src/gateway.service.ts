import { randomBytes, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { GatewayRpcSchemas } from '@movie-hub/contract';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { RpcFrame } from '@movie-hub/contract/socket-rpc';
import type {
  Authorization,
  PreparedDelivery,
  CommandRecord,
  PublicCommand,
  RemoteAuthorizationChange,
} from '@movie-hub/contract';
import { GatewayError, requireCondition } from './gateway.errors.js';
import { canonical, fingerprint, keyDigest, message, sameSession } from './gateway.domain.js';
import { seal, signed, validateDeviceKeys, verifyProof } from './gateway-crypto.service.js';
import {
  authenticateSchema,
  proofSchema,
  wireSchema,
  agentStatusSchema,
  identitySchema,
  executionSchema,
  resultSchema,
  statusSchema,
  protocolErrorSchema,
} from './gateway.schema.js';
import type { DeviceKeys, DownloadRequest, GatewayOptions, Peer, Session, WireMessage } from './gateway.types.js';

export class GatewayService {
  readonly peers = new Map<string, Peer>();
  readonly now: () => number;

  constructor(readonly options: GatewayOptions) {
    this.now = options.now ?? Date.now;
  }

  trace(stage: string, fields: Record<string, unknown>) {
    if (this.options.verbose) this.options.logger.info({ stage, ...fields }, 'gateway');
  }

  async keyAuthorization(digest: string, deviceId?: string, correlationId?: string): Promise<Authorization> {
    return this.options.popular.call(
      '__resolve_client_authorization__',
      { keyDigest: digest, ...(deviceId ? { deviceId } : {}) },
      correlationId
    );
  }

  async active(session: Session) {
    const route = await this.options.router.get(session.deviceId);
    requireCondition(route && sameSession(session, route), 'SESSION_REVOKED', 401);
  }

  async current(session: Session, correlationId?: string) {
    await this.active(session);
    return this.options.popular.call<Authorization>('__validate_session__', { context: session }, correlationId);
  }

  async message(peer: Peer, input: unknown) {
    const wire = wireSchema.parse(input) as WireMessage;
    const started = this.now();
    const correlationId = wire.correlationId ?? peer.id;
    this.trace('socket.entry', { correlationId, messageId: wire.messageId, command: wire.command });
    try {
      if (wire.command === '__authenticate__' || wire.command === '__auth_proof__') {
        const old = peer.handshake?.get(wire.messageId);
        if (old) {
          requireCondition(old.digest === fingerprint(wire), 'MESSAGE_ID_CONFLICT');
          if (peer.session) await this.current(peer.session, correlationId);
          else requireCondition(peer.challenge && peer.challenge.expiresAt > this.now(), 'CHALLENGE_EXPIRED', 401);
          peer.send(old.response);
          return;
        }
      }
      if (wire.command === '__authenticate__') return await this.authenticate(peer, wire);
      if (wire.command === '__auth_proof__') return await this.proof(peer, wire);
      requireCondition(peer.session, 'AUTHENTICATION_REQUIRED', 401);
      await this.current(peer.session, correlationId);
      if (wire.command === '__error__') {
        protocolErrorSchema.parse(wire.payload);
        return;
      }
      if (wire.command === '__agent_status__') {
        const status = agentStatusSchema.parse(wire.payload);
        requireCondition(await this.options.router.renew(peer.session, status), 'SESSION_REVOKED', 401);
        peer.status = status;
        return;
      }
      const event = { context: peer.session, agentMessageId: wire.messageId, agentDigest: fingerprint(wire) };
      if (wire.command === '__command_received__') {
        await this.options.popular.call(
          '__confirm_command_received__',
          { ...event, ...identitySchema.parse(wire.payload) },
          correlationId,
          wire.messageId
        );
        return;
      }
      if (wire.command === '__request_execution__') {
        const p = executionSchema.parse(wire.payload);
        requireCondition(peer.status?.configured && peer.status.reachable, 'DOWNLOADER_UNAVAILABLE');
        try {
          const response = await this.options.popular.call<{ decision: 'granted'; command: CommandRecord }>(
            '__authorize_execution__',
            { context: peer.session, ...p, downloader: peer.status },
            correlationId,
            wire.messageId
          );
          await this.active(peer.session);
          const c = response.command;
          const grant = {
            protocolVersion: 1,
            command: '__execution_granted__',
            commandId: c.commandId,
            downloadId: c.downloadId,
            ownerId: c.ownerId,
            deviceId: c.deviceId,
            authVersion: c.authVersion,
            deviceVersion: c.deviceVersion,
            sessionId: c.grantSessionId,
            executionId: c.executionId,
            expiresAt: c.grantExpiresAt,
            correlationId: c.correlationId,
            torrentHash: c.torrentHash,
            downloader: c.executionDownloader,
          };
          peer.send(
            message(
              '__execution_granted__',
              { grant: await signed(this.options.signing, grant) },
              wire,
              c.correlationId
            )
          );
        } catch (error) {
          if (!(error instanceof RpcError) || error.effect === 'unknown') throw error;
          peer.send(message('__execution_denied__', { code: error.code }, wire));
        }
        return;
      }
      if (wire.command === '__command_result__') {
        const result = resultSchema.parse(wire.payload);
        const ack = await this.options.popular.call(
          '__record_command_result__',
          { ...event, result },
          correlationId,
          wire.messageId
        );
        await this.active(peer.session);
        peer.send(message('__command_result_ack__', ack, wire));
        return;
      }
      if (wire.command === '__download_status__') {
        const status = statusSchema.parse(wire.payload);
        requireCondition(
          status.evidence.instanceId === peer.status?.instanceId
          && status.evidence.downloaderType === peer.status.downloaderType,
          'DOWNLOADER_INSTANCE_MISMATCH'
        );
        const ack = await this.options.popular.call(
          '__record_download_status__',
          { ...event, status },
          correlationId,
          wire.messageId
        );
        await this.active(peer.session);
        peer.send(message('__download_status_ack__', ack, wire));
        return;
      }
      if (wire.command === '__execution_recovery__') {
        const result = await this.options.popular.call(
          '__recover_execution__',
          { context: peer.session, ...executionSchema.parse(wire.payload) },
          correlationId,
          wire.messageId
        );
        peer.send(message('__execution_recovery_result__', result, wire));
        return;
      }
      throw new GatewayError('UNSUPPORTED_COMMAND', 400);
    } catch (err) {
      this.options.logger.error(
        {
          err,
          stage: 'socket.failure',
          correlationId,
          command: wire.command,
          messageId: wire.messageId,
          durationMs: this.now() - started,
        },
        'gateway'
      );
      throw err;
    } finally {
      this.trace('socket.complete', { correlationId, command: wire.command, durationMs: this.now() - started });
    }
  }

  private respond(peer: Peer, wire: WireMessage, response: WireMessage) {
    peer.handshake ??= new Map();
    peer.handshake.set(wire.messageId, { digest: fingerprint(wire), response });
    peer.send(response);
  }

  private async authenticate(peer: Peer, wire: WireMessage) {
    requireCondition(!peer.session && !peer.challenge, 'AUTHENTICATION_ALREADY_STARTED');
    const p = authenticateSchema.parse(wire.payload);
    const keys = p.keys as DeviceKeys;
    await validateDeviceKeys(keys);
    requireCondition(
      p.intent === 'bind' ? !!p.operationId && !p.deviceId : !!p.deviceId && !p.operationId,
      'EXPLICIT_BIND_OR_DEVICE_REQUIRED',
      400
    );
    const a = await this.keyAuthorization(
      peer.digest,
      p.intent === 'authenticate' ? p.deviceId : undefined,
      wire.correlationId ?? peer.id
    );
    if (p.intent === 'authenticate')
      requireCondition(a.keys && fingerprint(a.keys) === fingerprint(keys), 'DEVICE_KEY_MISMATCH', 403);
    const expiresAt = this.now() + 10_000;
    const text = canonical({
      protocolVersion: 1,
      command: '__auth_proof__',
      audience: 'popular-helper-gateway',
      connectionId: peer.id,
      nonce: randomBytes(32).toString('base64url'),
      ownerId: a.ownerId,
      authVersion: a.authVersion,
      deviceVersion: a.deviceVersion,
      intent: p.intent,
      operationId: p.operationId,
      deviceId: p.deviceId,
      keysDigest: fingerprint(keys),
      expiresAt,
    });
    peer.challenge = {
      text,
      expiresAt,
      keys,
      authVersion: a.authVersion,
      ...(p.deviceId ? { deviceId: p.deviceId } : {}),
      ...(p.operationId ? { operationId: p.operationId } : {}),
    };
    this.respond(peer, wire, message('__auth_challenge__', { challenge: text, expiresAt }, wire));
  }

  private async proof(peer: Peer, wire: WireMessage) {
    const c = peer.challenge;
    delete peer.challenge;
    requireCondition(!peer.session && c && c.expiresAt > this.now(), 'CHALLENGE_EXPIRED', 401);
    await verifyProof(proofSchema.parse(wire.payload).proof, c.text, c.keys);
    const a = c.operationId
      ? await this.options.popular.call<Authorization>(
          '__bind_device__',
          {
            keyDigest: peer.digest,
            authVersion: c.authVersion,
            operationId: c.operationId,
            keys: c.keys,
          },
          wire.correlationId ?? peer.id,
          c.operationId
        )
      : await this.keyAuthorization(peer.digest, c.deviceId, wire.correlationId ?? peer.id);
    requireCondition(
      a.active
      && a.deviceId
      && a.deviceVersion
      && a.authVersion === c.authVersion
      && fingerprint(a.keys) === fingerprint(c.keys),
      'AUTHORIZATION_CHANGED',
      401
    );
    const session: Session = {
      ownerId: a.ownerId,
      deviceId: a.deviceId,
      authVersion: a.authVersion,
      deviceVersion: a.deviceVersion,
      sessionId: randomUUID(),
      instanceId: this.options.instanceId,
    };
    await this.options.router.claim(session);
    peer.session = session;
    this.peers.set(peer.id, peer);
    await this.current(session, wire.correlationId ?? peer.id);
    await this.options.router.wake(session.deviceId);
    this.respond(
      peer,
      wire,
      message('__auth_result__', { authenticated: true, ...session, serverTime: this.now() }, wire)
    );
    this.options.logger.info(
      {
        stage: 'socket.authenticated',
        clientType: 'agent',
        connectionId: peer.id,
        correlationId: wire.correlationId ?? peer.id,
        gatewayInstanceId: this.options.instanceId,
        ownerId: session.ownerId,
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        authVersion: session.authVersion,
        deviceVersion: session.deviceVersion,
        outcome: 'authenticated',
      },
      'gateway'
    );
  }

  async handleRpc(command: string, payload: unknown, frame: RpcFrame): Promise<unknown> {
    const schema = GatewayRpcSchemas[command as keyof typeof GatewayRpcSchemas];
    requireCondition(schema && Value.Check(schema, payload), 'INVALID_REQUEST', 400);
    if (command === '__get_device_status__') {
      const p = payload as { ownerId: string; deviceId: string; authVersion: number; deviceVersion: number };
      const route = await this.options.router.get(p.deviceId);
      const online
        = route
          && route.ownerId === p.ownerId
          && route.authVersion === p.authVersion
          && route.deviceVersion === p.deviceVersion;
      return { online: !!online, ...(online ? { session: route, agentStatus: route.status ?? null } : {}) };
    }
    if (command === '__dispatch_download__') {
      const p = payload as DownloadRequest;
      const route = await this.options.router.get(p.deviceId);
      requireCondition(route, 'DEVICE_OFFLINE');
      requireCondition(
        route.ownerId === p.ownerId && route.authVersion === p.authVersion && route.deviceVersion === p.deviceVersion,
        'AUTHORIZATION_MISMATCH'
      );
      if (route.instanceId !== this.options.instanceId) {
        requireCondition(this.options.bus, 'DEVICE_OFFLINE');
        return this.options.bus.call(route.instanceId, 'gateway', frame);
      }
      const peer = [...this.peers.values()].find((peer) => peer.session && sameSession(peer.session, route));
      requireCondition(peer?.session && peer.status?.configured && peer.status.reachable, 'DOWNLOADER_UNAVAILABLE');
      return this.deliver(peer, p.commandId, p);
    }
    if (command === '__authorization_changed__') {
      const event = payload as RemoteAuthorizationChange;
      await this.options.router.wake(`owner:${event.ownerId}`);
      await this.pump(`owner:${event.ownerId}`);
      return { applied: true, eventId: event.eventId };
    }
    const p = payload as { eventId: string; ownerId: string };
    await this.options.router.wake(`owner:${p.ownerId}`);
    return { applied: true, eventId: p.eventId };
  }

  private async deliver(peer: Peer, commandId: string, original?: DownloadRequest): Promise<PublicCommand> {
    const session = peer.session!;
    await this.current(session, original?.correlationId ?? peer.id);
    const prepared = await this.options.popular.call<PreparedDelivery>(
      '__prepare_delivery__',
      { context: session, commandId },
      original?.correlationId ?? peer.id
    );
    let c = prepared.command;
    if (original) requireCondition(c.digest === fingerprint(original), 'IDEMPOTENCY_CONFLICT');
    if (!c.envelope) {
      requireCondition(prepared.torrent, 'TORRENT_HASH_REQUIRED');
      const envelope = await seal(this.options.signing, prepared.keys, {
        protocolVersion: 1,
        command: '__add_download__',
        messageId: c.deliveryMessageId,
        commandId: c.commandId,
        downloadId: c.downloadId,
        ownerId: c.ownerId,
        deviceId: c.deviceId,
        authVersion: c.authVersion,
        deviceVersion: c.deviceVersion,
        sessionId: session.sessionId,
        source: c.source,
        resourceId: c.resourceId,
        correlationId: c.correlationId,
        expiresAt: c.expiresAt,
        torrentUrl: prepared.torrent.url,
        torrentHash: prepared.torrent.torrentHash,
      });
      await this.active(session);
      c = await this.options.popular.call<CommandRecord>(
        '__save_delivery__',
        { context: session, commandId, deliveryMessageId: c.deliveryMessageId, envelope },
        c.correlationId
      );
    }
    await this.current(session, c.correlationId);
    requireCondition(c.deliverySessionId === session.sessionId && c.expiresAt > this.now(), 'DELIVERY_EXPIRED');
    peer.send({
      protocolVersion: 1,
      command: '__add_download__',
      messageId: c.deliveryMessageId,
      correlationId: c.correlationId,
      payload: { envelope: c.envelope },
    });
    return {
      commandId: c.commandId,
      downloadId: c.downloadId,
      state: c.state,
      expiresAt: c.expiresAt,
      accepted: true,
      added: false,
    };
  }

  async pump(deviceId: string) {
    const peers = [...this.peers.values()].filter((p) => {
      return (
        p.session
        && (deviceId.startsWith('owner:') ? p.session.ownerId === deviceId.slice(6) : p.session.deviceId === deviceId)
      );
    });
    for (const p of peers) {
      try {
        await this.current(p.session!, p.id);
        if (!p.status?.configured || !p.status.reachable) continue;
        const pending = await this.options.popular.call<{ commandIds: string[] }>('__list_pending_deliveries__', {
          context: p.session,
        });
        for (const id of pending.commandIds) await this.deliver(p, id);
      } catch (error) {
        const code = error instanceof RpcError || error instanceof GatewayError ? error.code : 'POPULAR_UNAVAILABLE';
        if (code === 'SESSION_REVOKED') await this.disconnect(p);
        else this.options.logger.error({ err: error, stage: 'delivery.poll' }, 'gateway');
      }
    }
  }

  async sweep() {
    const peers = [...this.peers.values()];
    for (let offset = 0; offset < peers.length; offset += 16) {
      await Promise.allSettled(
        peers.slice(offset, offset + 16).map(async (p) => {
          if (!p.session) return;
          try {
            await this.current(p.session);
            requireCondition(await this.options.router.renew(p.session, p.status), 'SESSION_REVOKED', 401);
          } catch (error) {
            this.options.logger.error(
              { err: error, stage: 'session.validate', sessionId: p.session.sessionId },
              'gateway'
            );
            if ((error instanceof RpcError || error instanceof GatewayError) && error.code === 'SESSION_REVOKED')
              await this.disconnect(p);
            else {
              p.close(1013);
              await this.dropped(p);
            }
          }
        })
      );
    }
  }

  async disconnect(peer: Peer) {
    this.peers.delete(peer.id);
    try {
      peer.send(message('__session_revoked__', { code: 'SESSION_REVOKED' }));
    } finally {
      peer.close(4001);
      if (peer.session) await this.options.router.release(peer.session);
    }
  }

  async dropped(peer: Peer) {
    this.peers.delete(peer.id);
    if (peer.session) await this.options.router.release(peer.session);
  }

  async signingKeys(apiKey: string, correlationId?: string) {
    await this.keyAuthorization(keyDigest(apiKey), undefined, correlationId);
    return { keys: [this.options.signing.publicKey] };
  }
}
