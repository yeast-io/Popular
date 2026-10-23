import { Redis } from 'ioredis';
import { once } from 'node:events';
import { gatewayLogger } from '../gateway-logging.service.js';
import type { AgentStatus, Route, Router, Session } from '../gateway.types.js';

const renewScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local old = cjson.decode(raw)
if old.sessionId ~= ARGV[1] or old.instanceId ~= ARGV[2] then return 0 end
if ARGV[3] ~= '' then old.status = cjson.decode(ARGV[3]); old.statusObservedAt = tonumber(ARGV[5]) end
redis.call('SET', KEYS[1], cjson.encode(old), 'PX', ARGV[4])
return 1`;
const releaseScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local old = cjson.decode(raw)
if old.sessionId ~= ARGV[1] or old.instanceId ~= ARGV[2] then return 0 end
return redis.call('DEL', KEYS[1])`;
const limitScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count`;

export class RedisRouter implements Router {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

  constructor(
    readonly redis: Redis,
    readonly prefix = 'popular:gateway:v1:',
    readonly leaseMs = 45_000,
    readonly logger = gatewayLogger('error')
  ) {
    this.publisher = redis.duplicate();
    this.subscriber = redis.duplicate();
    // Callers also attach error diagnostics; listeners prevent an unhandled error event during startup.
    this.publisher.on('error', (err) => this.logger.error({ err, stage: 'redis.publisher' }, 'gateway'));
    this.subscriber.on('error', (err) => this.logger.error({ err, stage: 'redis.subscriber' }, 'gateway'));
  }

  private key(deviceId: string) {
    return `${this.prefix}device:${deviceId}`;
  }

  async claim(session: Session) {
    await this.redis.set(this.key(session.deviceId), JSON.stringify(session), 'PX', this.leaseMs);
  }

  async get(deviceId: string): Promise<Route | null> {
    const value = await this.redis.get(this.key(deviceId));
    return value ? (JSON.parse(value) as Route) : null;
  }

  async renew(session: Session, status?: AgentStatus, observedAt = Date.now()) {
    return (
      (await this.redis.eval(
        renewScript,
        1,
        this.key(session.deviceId),
        session.sessionId,
        session.instanceId,
        status ? JSON.stringify(status) : '',
        String(this.leaseMs),
        String(observedAt)
      )) === 1
    );
  }

  async release(session: Session) {
    await this.redis.eval(releaseScript, 1, this.key(session.deviceId), session.sessionId, session.instanceId);
  }

  async wake(deviceId: string) {
    await this.publisher.publish(`${this.prefix}wake`, deviceId);
  }

  async subscribe(handler: (deviceId: string) => void) {
    this.subscriber.on('message', (_channel, deviceId) => handler(deviceId));
    await this.subscriber.subscribe(`${this.prefix}wake`);
  }

  async rateLimit(key: string, limit: number, windowMs: number) {
    const count = await this.redis.eval(limitScript, 1, `${this.prefix}rate:${key}`, String(windowMs));
    return Number(count) <= limit;
  }

  async ready() {
    await Promise.all(
      [this.redis, this.publisher, this.subscriber].map(async (client) => {
        if (client.status !== 'ready') await once(client, 'ready', { signal: AbortSignal.timeout(5000) });
        await client.ping();
      })
    );
  }

  async close() {
    // disconnect() is bounded even when Redis is unavailable; pending callers fail closed.
    this.subscriber.disconnect();
    this.publisher.disconnect();
    this.redis.disconnect();
  }
}
