import type { Redis } from 'ioredis';
import type { TaskStatisticEvent, TaskStatistics } from '../background-tasks/background-task.types.js';

const RECORD = `
redis.call('hset',KEYS[1],'name',ARGV[1],'kind',ARGV[2])
if ARGV[3] == 'started' then
  redis.call('hincrby',KEYS[1],'started',1)
  redis.call('zadd',KEYS[2],ARGV[5],ARGV[4])
else
  redis.call('hincrby',KEYS[1],ARGV[6],1)
  redis.call('zrem',KEYS[2],ARGV[4])
end
redis.call('zremrangebyscore',KEYS[2],'-inf',ARGV[7])
redis.call('expire',KEYS[1],691200)
redis.call('expire',KEYS[2],600)
return 1`;

/** UTC daily counters retained for eight days; running entries expire after five minutes. */
export class RedisTaskStatisticsStore implements TaskStatistics {
  constructor(private readonly redis: Pick<Redis, 'eval' | 'status'>) {}

  async record(event: TaskStatisticEvent): Promise<void> {
    if (this.redis.status !== 'ready') return;
    if (!/^[a-z0-9-]+$/.test(event.name)) throw new Error('Invalid task statistic name');
    const date = new Date(event.startedAt).toISOString().slice(0, 10);
    const base = `{background-tasks}:${event.kind}:${event.name}`;
    await this.redis.eval(RECORD, 2, `${base}:daily:${date}`, `${base}:running`,
      event.name, event.kind, event.phase, event.executionId, event.startedAt + 300_000,
      event.outcome ?? 'success', Date.now());
  }
}
