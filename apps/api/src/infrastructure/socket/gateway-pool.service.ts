import WebSocket from 'ws';
import { SocketRpc, RpcError } from '@movie-hub/contract/socket-rpc';
import { PopularRpcSchemas } from '@movie-hub/contract';
import type { GatewayPoolOptions, GatewayPoolMember } from './gateway-pool.types.js';

export class GatewayPool {
  private stopped = true;
  private readonly members: GatewayPoolMember[];

  constructor(readonly options: GatewayPoolOptions) {
    this.members = Array.from({ length: options.size ?? 4 }, (_, slot) => ({ slot, attempt: 0, ready: false }));
    for (const address of options.urls) {
      const url = new URL(address);
      if (
        !['https:', 'wss:'].includes(url.protocol)
        && !(options.allowInsecure && ['http:', 'ws:'].includes(url.protocol))
      ) {
        throw new RpcError('WSS_REQUIRED', 'not_applied');
      }
      if (url.username || url.password || url.search || url.hash)
        throw new RpcError('INVALID_GATEWAY_URL', 'not_applied');
    }
  }

  get healthyCount() {
    return this.members.filter((m) => m.ready && m.rpc?.available).length;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    for (const m of this.members) this.connect(m);
  }

  async call<T = unknown>(command: string, payload: unknown, correlationId?: string, messageId?: string): Promise<T> {
    const healthy = this.members.filter((m) => m.ready && m.rpc?.available).sort((a, b) => a.rpc!.load - b.rpc!.load);
    if (!healthy.length) throw new RpcError('GATEWAY_UNAVAILABLE', 'not_applied');
    return healthy[0]!.rpc!.call<T>(command, payload, correlationId, messageId);
  }

  private connect(member: GatewayPoolMember) {
    if (this.stopped || !this.options.urls.length) return;
    const url = new URL(this.options.urls[member.slot % this.options.urls.length]!);
    url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
    url.pathname = '/service/v1/socket';
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.options.token}` },
      handshakeTimeout: 10_000,
      maxPayload: 65_536,
      perMessageDeflate: false,
      followRedirects: false,
    });
    member.socket = socket;
    const rpc = new SocketRpc({
      transport: {
        send: (text) =>
          socket.send(text, (error) => {
            if (error) socket.terminate();
          }),
        close: () => socket.terminate(),
        open: () => socket.readyState === WebSocket.OPEN,
        bufferedBytes: () => socket.bufferedAmount,
        onMessage: (handler) => {
          return socket.on('message', (data, binary) => {
            if (binary) socket.terminate();
            else handler(data.toString());
          });
        },
        onClose: (handler) => socket.once('close', handler),
      },
      allowed: Object.keys(PopularRpcSchemas),
      handle: this.options.handle,
      diagnostics: this.options.diagnostics,
    });
    member.rpc = rpc;
    socket.on('open', () => {
      void rpc
        .call(
          '__service_hello__',
          { popularInstanceId: this.options.instanceId, poolSlotId: String(member.slot) }
        )
        .then(() => {
          if (!this.stopped && socket.readyState === WebSocket.OPEN) {
            member.ready = true;
            member.attempt = 0;
          }
        })
        .catch((error) => {
          this.options.diagnostics.error(error, { stage: 'gateway-pool.hello' });
          socket.terminate();
        });
      let missed = 0;
      socket.on('pong', () => {
        missed = 0;
      });
      member.ping = setInterval(() => {
        if (++missed >= 3) socket.terminate();
        else socket.ping();
      }, 15_000);
      member.ping.unref();
    });
    socket.on('error', (error) => {
      return this.options.diagnostics.error(error, { stage: 'gateway-pool.connection', slot: member.slot });
    });
    socket.once('close', () => {
      member.ready = false;
      rpc.disconnect();
      clearInterval(member.ping);
      if (!this.stopped) {
        const backoff = Math.min(30_000, 250 * 2 ** Math.min(member.attempt++, 8));
        member.timer = setTimeout(() => this.connect(member), backoff + Math.floor(Math.random() * 250));
        member.timer.unref();
      }
    });
  }

  async stop() {
    this.stopped = true;
    for (const m of this.members) {
      clearTimeout(m.timer);
      clearInterval(m.ping);
      m.ready = false;
      m.rpc?.disconnect();
      m.socket?.terminate();
    }
    await Promise.allSettled(this.members.map((m) => m.rpc?.drain()));
  }
}
