import { RedisLockTrace } from '../../infrastructure/redis/lock-trace.js';
import { createHash, randomUUID } from 'node:crypto';
import { AiTrace, withAiTrace, type AiLogger } from '../../infrastructure/logging/ai-trace.js';
import type { Redis } from 'ioredis';
import type { TelegramService, TelegramTransport } from './telegram.service.js';
// Shared cursor and renewable lease allow multiple API instances without competing getUpdates consumers.
const RENEW = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],60) end return 0";
const CHECKPOINT =
  "if redis.call('get',KEYS[1]) == ARGV[1] then redis.call('set',KEYS[2],ARGV[2]); return 1 end return 0";
const RELEASE = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end return 0";
export class TelegramWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private readonly active = new Map<AbortController, Promise<void>>();
  private stopped = true;
  private readonly key: string;
  private readonly lockTrace: RedisLockTrace;
  constructor(
    private readonly redis: Redis,
    token: string,
    private readonly transport: TelegramTransport,
    private readonly service: TelegramService,
    private readonly report: () => void,
    private readonly logger?: AiLogger,
    lockTraceEnabled = false,
    private readonly pollTraceEnabled = false
  ) {
    this.lockTrace = new RedisLockTrace(lockTraceEnabled, logger, (key) => this.redis.ttl(key));
    this.key = `telegram:${createHash('sha256').update(token.split(':')[0]!).digest('hex')}`;
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.logger?.info?.(
      { event: 'telegram_worker_started', pollIntervalMs: 1_000, retryDelayMs: 15_000 },
      'Telegram polling started',
    );
    this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      let failed = false;
      this.running = this.tick()
        .catch(() => {
          failed = true;
          this.report();
        })
        .finally(
        () => this.schedule(failed ? 15_000 : 1_000)
      );
    }, delay);
    this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const controller = new AbortController();
    const task = this.poll(controller).finally(() => this.active.delete(controller));
    this.active.set(controller, task);
    return task;
  }

  private async poll(controller: AbortController): Promise<void> {
    const lease = randomUUID();
    const lock = `${this.key}:lock`;
    const cursor = `${this.key}:offset`;
    const trace = new AiTrace(
      this.logger,
      { event: 'telegram_poll', pollId: lease, channel: 'telegram' },
      '',
      'telegram.poll',
      this.pollTraceEnabled,
    );
    await withAiTrace(trace, async () => {
      let updateId: number | undefined;
      let locked = false;
      try {
        const acquired = await this.lockTrace.run(
          'acquire',
          [lock],
          () => this.redis.set(lock, lease, 'EX', 60, 'NX'),
          { lockType: 'telegram_poll', pollId: lease, leaseSeconds: 60 },
        );
        if (acquired !== 'OK') {
          return;
        }
        locked = true;
        controller.signal.throwIfAborted();
        const offset = Number((await trace.step('telegram.offset.load', () => this.redis.get(cursor))) ?? 0);
        const updates = await trace.step(
          'telegram.get_updates',
          () => this.transport.updates(offset, controller.signal),
          { offset },
        );
        trace.event('telegram.updates.received', { offset, updateCount: updates.length });
        for (const update of updates) {
          updateId = update.update_id;
          if (
            this.stopped ||
            (await this.lockTrace.run('renew', [lock], () => this.redis.eval(RENEW, 1, lock, lease), {
              lockType: 'telegram_poll',
              pollId: lease,
              leaseSeconds: 60,
            }
            )) !== 1
          ) {
            trace.event('telegram.update.skipped', {
              updateId,
              reason: this.stopped ? 'worker_stopped' : 'lease_lost',
            }
            );
            return;
          }
          await trace.step('telegram.update.accept', () => this.service.accept(update), {
            updateId,
            messageId: update.message?.message_id,
          }
          );
          if (
            (await trace.step(
              'telegram.offset.save',
              () => {
                return this.lockTrace.run(
                  'checkpoint',
                  [lock],
                  () => {
                    return this.redis.eval(CHECKPOINT, 2, lock, cursor, lease, String(update.update_id + 1));
                  },
                  { lockType: 'telegram_poll', pollId: lease, updateId },
                );
              },
              { updateId },
            )) !== 1
          ) {
            trace.event('telegram.checkpoint.rejected', { updateId, reason: 'lease_lost' });
            return;
          }
          trace.event('telegram.update.completed', { updateId, nextOffset: update.update_id + 1 });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          trace.event('telegram.poll.cancelled', { reason: 'worker_stopping' });
          return;
        }
        trace.fail(error, { updateId, retryDelayMs: 15_000 });
        throw error;
      } finally {
        if (locked) {
          try {
            await this.lockTrace.run('release', [lock], () => this.redis.eval(RELEASE, 1, lock, lease), {
              lockType: 'telegram_poll',
              pollId: lease,
            }
            );
          } catch (error) {
            trace.fail(error, { event: 'telegram_lock_release_failed', stage: 'telegram.lock.release' });
            // eslint-disable-next-line no-unsafe-finally -- A release failure must reject polling so the existing retry/report path still runs.
            throw error;
          }
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.logger?.info?.(
      { event: 'telegram_worker_stopping', activePolls: this.active.size },
      'Telegram worker stopping',
    );
    if (this.timer) clearTimeout(this.timer);
    for (const controller of this.active.keys()) controller.abort();
    const results = await Promise.allSettled([...this.active.values(), ...(this.running ? [this.running] : [])]);
    this.logger?.info?.({ event: 'telegram_worker_stopped' }, 'Telegram worker stopped');
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
