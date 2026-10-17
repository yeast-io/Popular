import assert from 'node:assert/strict';
import test from 'node:test';
import type { Redis } from 'ioredis';
import { TelegramWorker } from './telegram.worker.js';
import type { TelegramService, TelegramUpdate } from './telegram.service.js';

function fixture() {
  const values = new Map<string, string>();
  let polls = 0;
  let crash = false;
  let loseLease = false;
  const accepted: number[] = [];
  const update: TelegramUpdate = { update_id: 7 };
  const redis = {
    set: async (key: string, value: string) => { if (values.has(key)) return null; values.set(key, value); return 'OK'; },
    get: async (key: string) => values.get(key) ?? null,
    eval: async (script: string, count: number, ...args: string[]) => {
      const [lock] = args;
      const lease = args[count]!;
      if (loseLease) values.set(lock!, 'other-process');
      if (values.get(lock!) !== lease) return 0;
      if (count === 2) values.set(args[1]!, args[3]!);
      else if (script.includes("'del'")) values.delete(lock!);
      return 1;
    },
  } as unknown as Redis;
  const transport = { username: async () => 'Bot', send: async () => '1', sendPhoto: async () => '1', updates: async (offset: number) => { polls++; return offset <= 7 ? [update] : []; } };
  const service = { accept: async (item: TelegramUpdate) => { if (crash) throw new Error('database down'); accepted.push(item.update_id); } } as TelegramService;
  const worker = new TelegramWorker(redis, '123:secret', transport, service, () => {});
  return { worker, redis, values, accepted, transport, polls: () => polls, crash: (value: boolean) => { crash = value; }, lose: () => { loseLease = true; } };
}
test('shared lease prevents competing pollers; offset survives worker restart', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.worker.start();
  try {
    await f.worker.tick(); await f.worker.tick();
    assert.deepEqual(f.accepted, [7]);
    assert.equal([...f.values.values()].includes('8'), true);
    const lock = [...f.values.keys()][0]!.replace(':offset', ':lock');
    f.values.set(lock, 'another-process');
    await f.worker.tick(); assert.equal(f.polls(), 2);
    f.values.delete(lock);
    const restarted = new TelegramWorker(f.redis, '123:rotated-token', f.transport, { accept: async () => { assert.fail('acknowledged update replayed'); } } as unknown as TelegramService, () => {});
    restarted.start(); await restarted.tick(); await restarted.stop();
  } finally { await f.worker.stop(); }
});
test('storage failure retains update for retry; lost lease cannot consume or checkpoint', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.worker.start();
  try {
    f.crash(true); await assert.rejects(() => f.worker.tick());
    assert.equal(f.values.size, 0);
    f.crash(false); f.lose(); await f.worker.tick();
    assert.deepEqual(f.accepted, []);
    assert.equal([...f.values.keys()].some(key => key.endsWith(':offset')), false);
    assert.equal([...f.values.values()][0], 'other-process');
  } finally { await f.worker.stop(); }
});
