import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { messages } from './list-tasks.messages.mjs';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));

export function parseOptions(args, now = new Date()) {
  const options = { date: now.toISOString().slice(0, 10), locale: 'zh-CN', json: false, help: false };
  for (const arg of args) {
    if (arg === '--json') options.json = true;
    else if (arg === '--help') options.help = true;
    else if (arg.startsWith('--date=')) options.date = arg.slice(7);
    else if (arg.startsWith('--locale=')) options.locale = arg.slice(9);
    else throw new Error('Invalid argument');
  }
  if (!Object.hasOwn(messages, options.locale) || !/^\d{4}-\d{2}-\d{2}$/.test(options.date)
    || !Number.isFinite(Date.parse(options.date)) || new Date(options.date).toISOString().slice(0, 10) !== options.date)
    throw new Error('Invalid options');
  return options;
}

export async function readStatistics(redis, prefix, date, now = Date.now()) {
  const keys = new Set();
  let cursor = '0';
  // SCAN patterns do not receive ioredis keyPrefix. Use a raw client and literal-prefix filtering.
  const escapedPrefix = prefix.replace(/[\\*?[\]]/g, '\\$&');
  do {
    const page = await redis.scan(cursor, 'MATCH', `${escapedPrefix}{background-tasks}:*:daily:${date}`, 'COUNT', 100);
    cursor = page[0];
    for (const key of page[1]) if (key.startsWith(prefix)) keys.add(key);
  } while (cursor !== '0');
  const rows = [];
  const dayStart = Date.parse(date);
  const runningLower = Math.max(now, dayStart + 300_000 - 1);
  const runningUpper = dayStart + 86_400_000 + 300_000 - 1;
  for (const key of keys) {
    const data = await redis.hgetall(key);
    if (!data.name || !['poll', 'job'].includes(data.kind)) continue;
    const runningKey = key.slice(0, key.lastIndexOf(':daily:')) + ':running';
    rows.push({ name: data.name, kind: data.kind,
      started: Number(data.started ?? 0), success: Number(data.success ?? 0), failure: Number(data.failure ?? 0),
      cancelled: Number(data.cancelled ?? 0), running: Number(await redis.zcount(runningKey, `(${runningLower}`, runningUpper)),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

export function formatStatistics(rows, options) {
  if (options.json) return JSON.stringify({ date: options.date, timezone: 'UTC', runningWindowSeconds: 300, rows }, null, 2);
  const copy = messages[options.locale];
  const lines = rows.map((row) => `${copy.names[row.name] ?? row.name}（${copy[row.kind]}） ${copy.started} ${row.started} · ${copy.success} ${row.success} · ${copy.failure} ${row.failure} · ${copy.cancelled} ${row.cancelled} · ${copy.running} ${row.running}`);
  return [`${options.date} UTC`, ...(lines.length ? lines : [copy.empty]), copy.note].join('\n');
}

async function main() {
  let redis;
  let locale = 'zh-CN';
  try {
    const options = parseOptions(process.argv.slice(2));
    locale = options.locale;
    if (options.help) {
      console.log(messages[locale].help);
      return;
    }
    require('dotenv').config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('Missing Redis URL');
    const Redis = require('ioredis');
    redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 5000, commandTimeout: 5000, retryStrategy: () => null });
    redis.on('error', () => undefined);
    await redis.connect();
    const rows = await readStatistics(redis, process.env.REDIS_KEY_PREFIX ?? 'movie_hub:', options.date);
    console.log(formatStatistics(rows, options));
  } catch {
    // Connection errors can contain credentials; never print the raw Redis error or URL.
    console.error(messages[locale].error);
    process.exitCode = 1;
  } finally {
    redis?.disconnect();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
