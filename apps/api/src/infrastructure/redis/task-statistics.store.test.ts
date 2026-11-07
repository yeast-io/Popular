import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { RedisTaskStatisticsStore } from './task-statistics.store.js';

const hasRedis = spawnSync('redis-server', ['--version']).status === 0;

test('real Redis records concurrent counters, day boundaries, retention and CLI output', { skip: !hasRedis, timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp('/tmp/popular-task-stats-');
  const socket = join(directory, 'redis.sock');
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await new Promise<void>((resolve) => server.once('exit', () => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < 500 && !existsSync(socket); index++) await wait(10);
  assert.ok(existsSync(socket), 'temporary Redis must start');
  const redis = new Redis({ path: socket, keyPrefix: 'test:', lazyConnect: true, enableOfflineQueue: false });
  redis.on('error', () => undefined);
  t.after(() => redis.disconnect());
  await redis.connect();
  const store = new RedisTaskStatisticsStore(redis);
  const startedAt = Date.now();
  const date = new Date(startedAt).toISOString().slice(0, 10);
  await Promise.all(Array.from({ length: 10 }, (_, index) => store.record({ name: 'preferences', kind: 'job', startedAt,
    executionId: String(index), phase: 'started' })));
  await Promise.all(Array.from({ length: 7 }, (_, index) => store.record({ name: 'preferences', kind: 'job', startedAt,
    executionId: String(index), phase: 'finished', outcome: index === 0 ? 'failure' : 'success' })));
  const key = `{background-tasks}:job:preferences:daily:${date}`;
  const data = await redis.hgetall(key);
  assert.equal(data.started, '10');
  assert.equal(data.success, '6');
  assert.equal(data.failure, '1');
  assert.ok(await redis.ttl(key) <= 691200);
  assert.ok(await redis.ttl(key) > 691100);
  const previous = startedAt - 86_400_000;
  await store.record({ name: 'preferences', kind: 'job', startedAt: previous, executionId: 'old', phase: 'started' });
  assert.equal(await redis.zcard('{background-tasks}:job:preferences:running'), 3);
  const script = fileURLToPath(new URL('../../../../../tools/tasks/list-tasks.mjs', import.meta.url));
  const env = { ...process.env, REDIS_URL: socket, REDIS_KEY_PREFIX: 'test:' };
  const result = await promisify(execFile)(process.execPath, [script, '--json', `--date=${date}`], { env });
  const report = JSON.parse(result.stdout);
  assert.equal(report.rows[0].started, 10);
  assert.equal(report.rows[0].running, 3);
  const chinese = await promisify(execFile)(process.execPath, [script, `--date=${date}`], { env });
  assert.match(chinese.stdout, /偏好更新（任务） 执行 10/);
  const english = await promisify(execFile)(process.execPath, [script, '--locale=en-US', `--date=${date}`], { env });
  assert.match(english.stdout, /Preferences（jobs） runs 10/);
  const yesterday = await promisify(execFile)(process.execPath, [script, '--json', `--date=${new Date(previous).toISOString().slice(0, 10)}`], { env });
  assert.equal(JSON.parse(yesterday.stdout).rows[0].running, 0);
});

test('disconnected Redis is skipped and invalid names cannot create arbitrary cache keys', async () => {
  let calls = 0;
  const store = new RedisTaskStatisticsStore({ status: 'end', eval: async () => {
    calls++;
  } } as unknown as Redis);
  await store.record({ name: 'example', kind: 'poll', startedAt: 0, executionId: '1', phase: 'started' });
  assert.equal(calls, 0);
  const connected = new RedisTaskStatisticsStore({ status: 'ready', eval: async () => assert.fail() } as unknown as Redis);
  await assert.rejects(connected.record({ name: 'bad:key', kind: 'poll', startedAt: 0, executionId: '1', phase: 'started' }), /Invalid/);
});
