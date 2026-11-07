import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOptions, readStatistics, formatStatistics } from './list-tasks.mjs';

test('arguments validate real dates and default to UTC', () => {
  assert.equal(parseOptions([], new Date('2026-11-07T23:00:00-08:00')).date, '2026-11-08');
  assert.throws(() => parseOptions(['--date=2026-02-30']));
  assert.throws(() => parseOptions(['--locale=fr']));
  assert.throws(() => parseOptions(['--unknown']));
});

test('report traverses scan pages, deduplicates keys and respects the configured namespace', async () => {
  const prefix = 'test:';
  const key = 'test:{background-tasks}:job:preferences:daily:2026-11-07';
  const seen = [];
  const redis = {
    scan: async (cursor, ...args) => {
      seen.push(args);
      return cursor === '0' ? ['12', [key]] : ['0', [key, 'other:daily:2026-11-07']];
    },
    hgetall: async () => ({ name: 'preferences', kind: 'job', started: '3', success: '1', failure: '1' }),
    zcount: async (runningKey) => {
      assert.equal(runningKey, 'test:{background-tasks}:job:preferences:running');
      return 1;
    },
  };
  const rows = await readStatistics(redis, prefix, '2026-11-07', 1000);
  assert.equal(seen.length, 2);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { name: 'preferences', kind: 'job', started: 3, success: 1, failure: 1, cancelled: 0, running: 1 });
  assert.match(formatStatistics(rows, parseOptions(['--date=2026-11-07'])), /偏好更新（任务） 执行 3/);
  assert.match(formatStatistics(rows, parseOptions(['--locale=en-US'])), /Preferences（jobs） runs 3/);
  assert.equal(JSON.parse(formatStatistics(rows, parseOptions(['--json']))).rows[0].started, 3);
});
