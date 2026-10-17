import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { TelegramService, TelegramTransport } from './telegram.service.js';
// Shared cursor and renewable lease allow multiple API instances without competing getUpdates consumers.
const RENEW = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('expire',KEYS[1],60) end return 0";
const CHECKPOINT = "if redis.call('get',KEYS[1]) == ARGV[1] then redis.call('set',KEYS[2],ARGV[2]); return 1 end return 0";
const RELEASE = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end return 0";
export class TelegramWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = true;
  private readonly key: string;
  constructor(private readonly redis: Redis, token: string, private readonly transport: TelegramTransport,
    private readonly service: TelegramService, private readonly report: () => void) {
    this.key = `telegram:${createHash('sha256').update(token.split(':')[0]!).digest('hex')}`;
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false; this.schedule(0);
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      let failed = false;
      this.running = this.tick().catch(() => { failed = true; this.report(); }).finally(() => this.schedule(failed ? 15_000 : 1_000));
    }, delay);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    const lease = randomUUID();
    const lock = `${this.key}:lock`;
    const cursor = `${this.key}:offset`;
    if (await this.redis.set(lock, lease, 'EX', 60, 'NX') !== 'OK') return;
    try {
      const offset = Number(await this.redis.get(cursor) ?? 0);
      const updates = await this.transport.updates(offset);
      for (const update of updates) {
        if (this.stopped || await this.redis.eval(RENEW, 1, lock, lease) !== 1) return;
        await this.service.accept(update);
        // Consumption is atomic and idempotent; replay after a crash cannot rebind an account.
        if (await this.redis.eval(CHECKPOINT, 2, lock, cursor, lease, String(update.update_id + 1)) !== 1) return;
      }
    } finally { await this.redis.eval(RELEASE, 1, lock, lease); }
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.running; }
}
