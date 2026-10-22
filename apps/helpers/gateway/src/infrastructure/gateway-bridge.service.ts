import { randomUUID } from 'node:crypto';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { RpcFrame, SocketRpc } from '@movie-hub/contract/socket-rpc';
import type { GatewayBus, ServicePeer } from '../gateway.types.js';

export class GatewayBridge {
  private readonly peers = new Set<ServicePeer>();

  constructor(readonly bus?: GatewayBus) {}

  async add(rpc: SocketRpc) {
    const peer = { rpc, ready: true };
    this.peers.add(peer);
    await this.bus?.available(true);
    return peer;
  }

  async remove(peer: ServicePeer) {
    peer.ready = false;
    this.peers.delete(peer);
    await this.bus?.available(this.peers.size > 0);
  }

  local<T>(command: string, payload: unknown, correlationId: string, messageId: string): Promise<T> {
    const healthy = [...this.peers].filter((p) => p.ready && p.rpc.available).sort((a, b) => a.rpc.load - b.rpc.load);
    if (!healthy.length) return Promise.reject(new RpcError('POPULAR_UNAVAILABLE', 'not_applied'));
    return healthy[0]!.rpc.call<T>(command, payload, correlationId, messageId);
  }

  async call<T = unknown>(
    command: string,
    payload: unknown,
    correlationId: string = randomUUID(),
    messageId: string = randomUUID()
  ): Promise<T> {
    if (
      [...this.peers].some((p) => {
        return p.ready && p.rpc.available;
      })
    )
      return this.local<T>(command, payload, correlationId, messageId);
    const targets = (await this.bus?.instances(true)) ?? [];
    if (!targets.length) throw new RpcError('POPULAR_UNAVAILABLE', 'not_applied');
    return this.bus!.call<T>(targets[0]!, 'popular', {
      protocolVersion: 1,
      command,
      payload,
      correlationId,
      messageId,
    });
  }

  async ready() {
    if (![...this.peers].some((p) => p.ready && p.rpc.available) && !(await this.bus?.instances(true))?.length) {
      throw new RpcError('POPULAR_UNAVAILABLE', 'not_applied');
    }
  }

  relay(frame: RpcFrame) {
    return this.local(frame.command, frame.payload, frame.correlationId, frame.messageId);
  }

  async close() {
    for (const p of this.peers) p.rpc.disconnect();
    this.peers.clear();
    await this.bus?.available(false);
  }
}
