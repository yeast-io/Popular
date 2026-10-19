import type { LockAction, Fields } from './lock-trace.types.js';
import { randomUUID } from 'node:crypto';
import type { AiLogger } from '../logging/ai-trace.types.js';
import { serializeDiagnosticError } from '../logging/diagnostic-error.js';
const instanceId = randomUUID();

/** Trace lock commands without changing their result or logging ownership tokens. */
export class RedisLockTrace {
  constructor(
    private readonly enabled: boolean,
    private readonly logger?: AiLogger,
    private readonly ttl?: (key: string) => Promise<number>
  ) {}

  async run<T>(action: LockAction, keys: string[], execute: () => Promise<T>, fields: Fields = {}): Promise<T> {
    if (!this.enabled) return execute();
    const started = Date.now();
    const bindings = { event: 'redis_lock', processId: process.pid, instanceId, action, keys, ...fields };
    this.logger?.info?.({ ...bindings, stage: `redis.lock.${action}.started` }, 'Redis lock operation started');
    try {
      const result = await execute();
      const success = result === 'OK' || result === 1;
      const outcome =
        action === 'acquire'
          ? success
            ? 'acquired'
            : 'busy'
          : action === 'renew'
            ? success
              ? 'renewed'
              : 'lost'
            : action === 'release'
              ? success
                ? 'released'
                : 'not_owned'
              : success
                ? 'checkpointed'
                : 'lost';
      let ttlSeconds: number[] | undefined;
      if (!success && this.ttl) {
        try {
          ttlSeconds = await Promise.all(keys.map((key) => this.ttl!(key)));
        } catch (error) {
          this.logger?.error(
            { ...bindings, stage: 'redis.lock.ttl.failed', error: serializeDiagnosticError(error) },
            'Redis lock TTL inspection failed',
          );
        }
      }
      this.logger?.info?.(
        {
          ...bindings,
          stage: `redis.lock.${action}.${outcome}`,
          outcome,
          ttlSeconds,
          durationMs: Date.now() - started,
        },
        'Redis lock operation completed',
      );
      return result;
    } catch (error) {
      this.logger?.error(
        {
          ...bindings,
          stage: `redis.lock.${action}.failed`,
          durationMs: Date.now() - started,
          error: serializeDiagnosticError(error),
        },
        'Redis lock operation failed',
      );
      throw error;
    }
  }
}
