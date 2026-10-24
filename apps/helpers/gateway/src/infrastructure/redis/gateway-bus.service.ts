import { randomBytes, randomUUID, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { Redis } from 'ioredis';
import { once } from 'node:events';
import { GatewayError } from '../../gateway.errors.js';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { RpcFrame } from '@movie-hub/contract/socket-rpc';
import type { Logger } from 'pino';
import type { GatewayBus, RelayPending, RelayRequest } from '../../gateway.types.js';

const enqueue = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('LLEN', KEYS[2]) >= 128 then return -1 end
redis.call('RPUSH', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], 45000)
return 1`;
/** Redis is a bounded encrypted relay, not the command ledger. Pub/Sub only wakes durable inbox polling. */
export class RedisGatewayBus implements GatewayBus {
  private readonly subscriber: Redis;
  private readonly pending = new Map<string, RelayPending>();
  private readonly key: Buffer;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private draining = false;
  private serviceAvailable = false;
  private stopped = false;
  private handler?: (kind: 'popular' | 'gateway', frame: RpcFrame) => Promise<unknown>;
  private readonly jobs = new Set<Promise<void>>();

  constructor(
    readonly redis: Redis,
    readonly instanceId: string,
    token: string,
    readonly logger: Logger,
    readonly prefix = 'popular:gateway:v1:relay:'
  ) {
    this.subscriber = redis.duplicate();
    this.subscriber.on('error', (err) => logger.error({ err, stage: 'relay.subscribe' }, 'gateway'));
    this.key = Buffer.from(
      hkdfSync('sha256', Buffer.from(token), Buffer.from('popular-gateway-relay'), Buffer.from('aes-256-gcm-v1'), 32)
    );
  }

  private seal(value: unknown) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  private unseal(value: string): unknown {
    const b = Buffer.from(value, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString());
  }

  private async lease() {
    const deadline = Date.now() + 45_000;
    await this.redis.zremrangebyscore(this.prefix + 'instances', '-inf', Date.now());
    await this.redis.zremrangebyscore(this.prefix + 'services', '-inf', Date.now());
    await this.redis.set(this.prefix + 'live:' + this.instanceId, '1', 'PX', 45_000);
    await this.redis.zadd(this.prefix + 'instances', deadline, this.instanceId);
    if (this.serviceAvailable) await this.redis.zadd(this.prefix + 'services', deadline, this.instanceId);
    else await this.redis.zrem(this.prefix + 'services', this.instanceId);
  }

  async instances(serviceOnly = false) {
    return this.redis.zrangebyscore(this.prefix + (serviceOnly ? 'services' : 'instances'), Date.now(), '+inf');
  }

  async available(value: boolean) {
    this.serviceAvailable = value;
    if (!this.stopped) await this.lease();
  }

  async start(handler: (kind: 'popular' | 'gateway', frame: RpcFrame) => Promise<unknown>) {
    this.handler = handler;
    if (this.subscriber.status !== 'ready') await once(this.subscriber, 'ready', { signal: AbortSignal.timeout(5000) });
    await this.lease();
    this.subscriber.on('message', () => {
      void this.poll();
    });
    await this.subscriber.subscribe(this.prefix + 'wake:' + this.instanceId);
    this.timer = setInterval(() => {
      void this.poll();
    }, 250);
    this.timer.unref();
    this.heartbeat = setInterval(() => {
      void this.lease().catch((err) => this.logger.error({ err, stage: 'relay.lease' }, 'gateway'));
    }, 15_000);
    this.heartbeat.unref();
  }

  async call<T>(target: string, kind: 'popular' | 'gateway', frame: RpcFrame): Promise<T> {
    if (this.stopped || this.pending.size >= 128) throw new RpcError('SERVICE_BUSY', 'not_applied');
    const id = randomUUID();
    const req: RelayRequest = { id, source: this.instanceId, kind, expiresAt: Date.now() + 30_000, frame };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('RPC_TIMEOUT'));
      }, 30_500);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      void this.redis
        .eval(enqueue, 2, this.prefix + 'live:' + target, this.prefix + 'inbox:' + target, this.seal(req))
        .then(async (accepted) => {
          if (accepted !== 1)
            throw new RpcError(accepted === -1 ? 'SERVICE_BUSY' : 'GATEWAY_UNAVAILABLE', 'not_applied');
          await this.redis.publish(this.prefix + 'wake:' + target, 'wake');
        })
        .catch((error) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        });
    });
  }

  private async poll() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      for (const [id, pending] of this.pending) {
        const reply = await this.redis.getdel(this.prefix + 'reply:' + id);
        if (!reply) continue;
        const result = this.unseal(reply) as {
          ok: boolean;
          data?: unknown;
          code?: string;
          effect?: 'not_applied' | 'unknown';
        };
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (result.ok) pending.resolve(result.data);
        else pending.reject(new RpcError(result.code ?? 'INTERNAL_ERROR', result.effect ?? 'unknown'));
      }
      while (this.jobs.size < 32) {
        const raw = await this.redis.lpop(this.prefix + 'inbox:' + this.instanceId);
        if (!raw) break;
        const job = this.process(raw).catch((err) => this.logger.error({ err, stage: 'relay.receive' }, 'gateway'));
        this.jobs.add(job);
        void job.finally(() => this.jobs.delete(job));
      }
    } catch (err) {
      this.logger.error({ err, stage: 'relay.poll' }, 'gateway');
    } finally {
      this.draining = false;
    }
  }

  private async process(raw: string) {
    const req = this.unseal(raw) as RelayRequest;
    if (req.expiresAt <= Date.now() || this.stopped || !this.handler) return;
    let response: unknown;
    try {
      response = { ok: true, data: await this.handler(req.kind, req.frame) };
    } catch (err) {
      this.logger.error({ err, stage: 'relay.handle', correlationId: req.frame.correlationId }, 'gateway');
      response = {
        ok: false,
        code: err instanceof RpcError || err instanceof GatewayError ? err.code : 'INTERNAL_ERROR',
        effect: err instanceof RpcError ? err.effect : err instanceof GatewayError ? 'not_applied' : 'unknown',
      };
    }
    await this.redis.set(this.prefix + 'reply:' + req.id, this.seal(response), 'PX', 10_000);
    await this.redis.publish(this.prefix + 'wake:' + req.source, 'wake');
  }

  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.subscriber.disconnect();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError('RPC_CONNECTION_CLOSED'));
    }
    this.pending.clear();
    await Promise.allSettled(this.jobs);
    await this.redis.del(this.prefix + 'live:' + this.instanceId, this.prefix + 'inbox:' + this.instanceId);
    await this.redis.zrem(this.prefix + 'instances', this.instanceId);
    await this.redis.zrem(this.prefix + 'services', this.instanceId);
  }
}
