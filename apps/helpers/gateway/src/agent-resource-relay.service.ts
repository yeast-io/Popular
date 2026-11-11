import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { AgentResourceReplySchema, AgentResourceResultSchemas } from '@movie-hub/contract';
import type { AgentResourceRequest, WireMessage } from '@movie-hub/contract';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import { message, sameSession } from './gateway.domain.js';
import { signed } from './gateway-crypto.service.js';
import type { Peer, SigningIdentity } from './gateway.types.js';
import type { ResourcePending } from './agent-resource.types.js';

export class AgentResourceRelay {
  private readonly pending = new Map<string, ResourcePending>();

  async request(
    peer: Peer,
    signing: SigningIdentity,
    request: AgentResourceRequest,
    correlationId: string,
    deadline: number
  ): Promise<unknown> {
    if (!peer.session || peer.status?.resourceProtocol !== 1)
      throw new RpcError('AGENT_RESOURCE_UNSUPPORTED', 'not_applied');
    if (this.pending.size >= 128) throw new RpcError('AGENT_RESOURCE_BUSY', 'not_applied');
    const session = { ...peer.session };
    const requestId = randomUUID();
    const expiresAt = Math.min(deadline, Date.now() + 25_000);
    const token = await signed(signing, {
      ...session,
      protocolVersion: 1,
      command: '__resource_request__',
      messageId: requestId,
      correlationId,
      expiresAt,
      request,
    });
    if (expiresAt <= Date.now()) throw new RpcError('AGENT_RESOURCE_TIMEOUT', 'not_applied');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RpcError('AGENT_RESOURCE_TIMEOUT', 'not_applied'));
      }, expiresAt - Date.now());
      timer.unref();
      this.pending.set(requestId, { session, correlationId, operation: request.operation, resolve, reject, timer });
      try {
        peer.send({ ...message('__resource_request__', { request: token }), messageId: requestId, correlationId });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  accept(peer: Peer, wire: WireMessage): void {
    const entry = wire.replyTo ? this.pending.get(wire.replyTo) : undefined;
    if (
      !entry
      || !peer.session
      || !sameSession(entry.session, peer.session)
      || wire.correlationId !== entry.correlationId
    )
      return;
    this.pending.delete(wire.replyTo!);
    clearTimeout(entry.timer);
    if (!Value.Check(AgentResourceReplySchema, wire.payload)) {
      entry.reject(new RpcError('AGENT_RESOURCE_INVALID_RESPONSE', 'not_applied'));
      return;
    }
    const value = wire.payload;
    if (!value.ok) {
      entry.reject(
        new RpcError(`AGENT_${value.code.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`, 'not_applied')
      );
      return;
    }
    if (
      JSON.stringify(value.result).length > 55_000
      || !Value.Check(AgentResourceResultSchemas[entry.operation], value.result)
    ) {
      entry.reject(new RpcError('AGENT_RESOURCE_INVALID_RESPONSE', 'not_applied'));
      return;
    }
    entry.resolve(value.result);
  }

  dropped(peer: Peer): void {
    if (!peer.session) return;
    for (const [id, entry] of this.pending)
      if (sameSession(entry.session, peer.session)) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(new RpcError('DEVICE_OFFLINE', 'not_applied'));
      }
  }
}
