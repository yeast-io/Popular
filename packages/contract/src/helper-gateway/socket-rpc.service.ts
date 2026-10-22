import { randomUUID, createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { RpcFrameSchema, RpcResultSchema } from './socket-rpc.schema.js';
import type { RpcFrame, RpcOptions, RpcPending } from './socket-rpc.types.js';

export type { RpcFrame, RpcOptions, RpcTransport, RpcCaller, RpcDiagnostics } from './socket-rpc.types.js';
export class RpcError extends Error {
  constructor(readonly code: string, readonly effect: 'not_applied' | 'unknown' = 'unknown', options?: ErrorOptions) {
    super(code, options);
    this.name = 'RpcError';
  }
}
export class SocketRpc {
  private readonly pending = new Map<string, RpcPending>();
  private readonly incoming = new Map<string, { digest: string; result: Promise<RpcFrame> }>();
  private active = 0;
  private readonly jobs = new Set<Promise<RpcFrame>>();
  private closed = false;

  constructor(readonly options: RpcOptions) {
    options.transport.onMessage((text) => {
      void this.receive(text);
    });
    options.transport.onClose(() => this.disconnect());
  }

  get available() { return !this.closed && this.options.transport.open(); }

  get load() { return this.pending.size; }

  async call<T = unknown>(command: string, payload: unknown, correlationId: string = randomUUID(), messageId: string = randomUUID()): Promise<T> {
    if (!this.available) throw new RpcError('GATEWAY_UNAVAILABLE', 'not_applied');
    if (this.pending.size >= (this.options.maxInFlight ?? 64)) throw new RpcError('SERVICE_BUSY', 'not_applied');
    if (this.pending.has(messageId)) throw new RpcError('REQUEST_ALREADY_PENDING', 'not_applied');
    const frame: RpcFrame = { protocolVersion: 1, command, messageId, correlationId, payload };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(messageId);
          reject(new RpcError('RPC_TIMEOUT'));
        },
        this.options.timeoutMs ?? 30_000
      );
      this.pending.set(messageId, { resolve: (value) => resolve(value as T), reject, timer, command, correlationId });
      try {
        this.send(frame);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(messageId);
        reject(error);
      }
    });
  }

  private send(frame: RpcFrame) {
    if (!this.available) throw new RpcError('RPC_CONNECTION_CLOSED');
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > 65_536) throw new RpcError('MESSAGE_TOO_LARGE', 'not_applied');
    if (this.options.transport.bufferedBytes() > (this.options.maxBufferedBytes ?? 1_048_576)) throw new RpcError('SERVICE_BUSY', 'not_applied');
    this.options.transport.send(text);
  }

  private async receive(text: string) {
    let frame: RpcFrame;
    try {
      if (Buffer.byteLength(text) > 65_536) throw new RpcError('MESSAGE_TOO_LARGE', 'not_applied');
      const value: unknown = JSON.parse(text);
      if (!Value.Check(RpcFrameSchema, value)) throw new RpcError('INVALID_MESSAGE', 'not_applied');
      frame = value;
    } catch (error) {
      this.options.diagnostics.error(error, { stage: 'rpc.protocol' });
      this.options.transport.close();
      return;
    }
    if (frame.command === '__rpc_result__') {
      const pending = frame.replyTo ? this.pending.get(frame.replyTo) : undefined;
      if (!pending) return;
      if (!Value.Check(RpcResultSchema, frame.payload) || frame.payload.requestCommand !== pending.command || frame.correlationId !== pending.correlationId) {
        this.options.transport.close();
        this.disconnect();
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(frame.replyTo!);
      if (frame.payload.ok) pending.resolve(frame.payload.data);
      else pending.reject(new RpcError(frame.payload.error.code, frame.payload.error.effect));
      return;
    }
    const started = Date.now();
    const fields = { stage: 'rpc.request', command: frame.command, messageId: frame.messageId, correlationId: frame.correlationId };
    const canonical = (value: unknown): string => {
      return JSON.stringify(value, (_key, v: unknown) => {
        return v && typeof v === 'object' && !Array.isArray(
          v
        )
          ? Object.fromEntries(
              Object.entries(v).sort(([a], [b]) => a.localeCompare(b))
            )
          : v;
      });
    };
    const digest = createHash('sha256').update(canonical(frame)).digest('hex');
    try {
      const old = this.incoming.get(frame.messageId);
      if (old) {
        if (old.digest !== digest) throw new RpcError('IDEMPOTENCY_CONFLICT', 'not_applied');
        this.send(await old.result);
        return;
      }
      if (!this.options.allowed.includes(frame.command)) throw new RpcError('RPC_DIRECTION_FORBIDDEN', 'not_applied');
      if (this.active >= (this.options.maxInFlight ?? 64)) throw new RpcError('SERVICE_BUSY', 'not_applied');
      this.active++;
      if (this.options.diagnostics.verbose) this.options.diagnostics.info({ ...fields, outcome: 'started' });
      const result = this.execute(frame).finally(() => {
        this.active--;
      });
      this.jobs.add(result);
      this.incoming.set(frame.messageId, { digest, result });
      // Retain active requests; evict only completed entries and never use this cache as durable business deduplication.
      void result.then((response) => {
        this.jobs.delete(result);
        if (!(response.payload as { ok: boolean }).ok || this.incoming.size > 128) {
          if (this.incoming.get(frame.messageId)?.result === result) this.incoming.delete(frame.messageId);
          return;
        }
        const timer = setTimeout(() => {
          if (this.incoming.get(frame.messageId)?.result === result) this.incoming.delete(frame.messageId);
        }, 30_000
        );
        timer.unref();
      });
      this.send(await result);
      if (this.options.diagnostics.verbose) this.options.diagnostics.info({ ...fields, outcome: 'completed', durationMs: Date.now() - started });
    } catch (error) {
      this.options.diagnostics.error(error, { ...fields, durationMs: Date.now() - started });
      try {
        this.send(this.errorFrame(frame, error));
      } catch {
        this.options.transport.close();
      }
    }
  }

  private async execute(frame: RpcFrame): Promise<RpcFrame> {
    try {
      const data = await this.options.handle(frame.command, frame.payload, frame);
      return { protocolVersion: 1, command: '__rpc_result__', messageId: randomUUID(), replyTo: frame.messageId,
        correlationId: frame.correlationId, payload: { requestCommand: frame.command, ok: true, data: data ?? null } };
    } catch (error) {
      this.options.diagnostics.error(error, { stage: 'rpc.handler', command: frame.command, correlationId: frame.correlationId });
      // Transient failures must be retried against the business ledger, not cached forever on this connection.
      return this.errorFrame(frame, error);
    }
  }

  private errorFrame(frame: RpcFrame, error: unknown): RpcFrame {
    return { protocolVersion: 1, command: '__rpc_result__', messageId: randomUUID(), replyTo: frame.messageId,
      correlationId: frame.correlationId, payload: { requestCommand: frame.command, ok: false, error: {
        code: error instanceof RpcError ? error.code : 'INTERNAL_ERROR',
        retryable: !(error instanceof RpcError) || ['SERVICE_BUSY', 'POPULAR_UNAVAILABLE', 'RPC_TIMEOUT'].includes(error.code),
        effect: error instanceof RpcError ? error.effect : 'unknown',
      } } };
  }

  async drain() { await Promise.allSettled([...this.jobs]); }

  disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError('RPC_CONNECTION_CLOSED'));
    }
    this.pending.clear();
    this.incoming.clear();
  }
}
