import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceNotificationService } from './resource-notification.service.js';
import { ResourceNotificationWorker } from './resource-notification.worker.js';
import { createResourceNotification, matchesTvResource } from './resource-notification.domain.js';
import type {
  ResourceNotificationDependencies,
  ResourceNotificationEntry,
  ResourceNotificationStore,
} from './resource-notification.types.js';
import type { ResourceSiteRelease } from '@movie-hub/contract';

function fixture() {
  let now = new Date('2026-10-26T00:00:00Z');
  const rows = new Map<string, ResourceNotificationEntry[]>();
  const configured = new Map([
    ['one', true],
    ['two', true],
  ]);
  const sent: Array<{ ownerId: string; channel: string; locale: string }> = [];
  const failures = new Set<string>();
  const logs: unknown[] = [];
  let searches = 0;
  const store: ResourceNotificationStore = {
    list: async (owner) => rows.get(owner) ?? [],
    add: async (owner, entry) => {
      const list = rows.get(owner) ?? [];
      if (list.some((item) => item.mediaType === entry.mediaType && item.tmdbId === entry.tmdbId)) return true;
      if (list.length >= 5) return false;
      list.push(entry);
      rows.set(owner, list);
      return true;
    },
    remove: async (owner, mediaType, tmdbId) => {
      rows.set(
        owner,
        (rows.get(owner) ?? []).filter((item) => item.mediaType !== mediaType || item.tmdbId !== tmdbId)
      );
    },
    claim: async (at, next) => {
      for (const [ownerId, list] of rows) {
        const entry = list.find((item) => item.status === 'pending' && item.nextRunAt <= at && item.lockedUntil <= at);
        if (!entry) continue;
        entry.nextRunAt = next;
        entry.lockedUntil = new Date(at.getTime() + 120_000);
        entry.leaseId = 'lease';
        entry.attempts++;
        return { ownerId, entry, leaseId: 'lease' };
      }
      return null;
    },
    renew: async (claim, at) => {
      const entry = rows
        .get(claim.ownerId)
        ?.find((item) => item.id === claim.entry.id && item.leaseId === claim.leaseId);
      if (!entry || entry.lockedUntil <= at) return false;
      entry.lockedUntil = new Date(at.getTime() + 120_000);
      return true;
    },
    markNotified: async (claim, at) => {
      claim.entry.status = 'notified';
      claim.entry.notifiedAt = at;
      return true;
    },
    finish: async (claim, outcome) => {
      claim.entry.lastOutcome = outcome;
      claim.entry.lockedUntil = new Date(0);
      delete claim.entry.leaseId;
    },
  };
  const dependencies: ResourceNotificationDependencies = {
    notifications: {
      listChannels: async () => [...configured].map(([id, configured]) => ({ id, name: id, configured })),
      channel: (id) => ({
        id,
        name: id,
        isConfigured: async () => configured.get(id) ?? false,
        send: async () => ({ messageId: 'unused' }),
        sendResource: async (ownerId, message) => {
          if (failures.has(id)) throw new Error('delivery failed');
          sent.push({ ownerId, channel: id, locale: message.locale });
          return { messageId: id };
        },
      }),
    },
    movies: {
      readMovies: async (ids) => ids.map((tmdbId) => ({ tmdbId, title: `Movie ${tmdbId}`, genreIds: [] })),
      readMovieDetail: async (tmdbId) => ({
        tmdbId,
        title: 'Movie',
        imdbId: 'tt1234567',
        genreIds: [],
        genres: [],
        cast: [],
        directors: [],
      }),
    },
    tv: {
      readSummaries: async (ids) =>
        ids.map((tmdbId) => ({ tmdbId, mediaType: 'tv', name: 'Some Show', originalName: 'Some Show', genreIds: [] })),
      readDetail: async (tmdbId) => ({
        tmdbId,
        mediaType: 'tv',
        name: 'Some Show',
        originalName: 'Some Show',
        genreIds: [],
      }),
    },
    search: {
      search: async () => {
        searches++;
        return { releases: [{ id: 'release', title: 'Some.Show.S01E02.1080p', seeders: 2, imdbId: 'tt1234567' }] };
      },
    },
    enabledSites: async () => ['site-one'],
    resolveLocale: async () => 'en-US',
    logger: {
      error: (value: unknown) => {
        logs.push(value);
      },
    },
    verbose: false,
    webOrigin: 'https://popular.test',
    intervalMs: 10_800_000,
    now: () => now,
  };
  const service = new ResourceNotificationService(store, dependencies);
  async function add(owner = 'alice', id = 1, mediaType: 'movie' | 'tv' = 'movie') {
    await store.add(owner, createResourceNotification(mediaType, id, 'A title', now));
  }
  return {
    rows,
    store,
    dependencies,
    service,
    configured,
    sent,
    failures,
    logs,
    add,
    searches: () => searches,
    advance: () => {
      now = new Date(now.getTime() + dependencies.intervalMs);
    },
  };
}

test('service requires communication channels, caps mixed media at 5 including notified, allows idempotent add and isolates owners', async () => {
  const f = fixture();
  f.configured.set('one', false);
  f.configured.set('two', false);
  await assert.rejects(f.service.add('alice', 'movie', 1, 'zh-CN'), {
    code: 'RESOURCE_NOTIFICATION_CHANNEL_REQUIRED',
    message: '请先配置通信工具，再加入资源通知列表。',
  });
  f.configured.set('one', true);
  for (let i = 1; i <= 5; i++) await f.service.add('alice', i % 2 ? 'movie' : 'tv', i, 'en-US');
  f.rows.get('alice')![0]!.status = 'notified';
  await assert.rejects(f.service.add('alice', 'movie', 6, 'en-US'), { code: 'RESOURCE_NOTIFICATION_LIMIT_REACHED' });
  await f.service.add('alice', 'movie', 1, 'en-US');
  assert.equal((await f.service.list('alice', 'en-US')).items.length, 5);
  assert.deepEqual(await f.service.membership('bob', 'movie', 1), { enabled: false });
  await f.service.remove('bob', 'movie', 1);
  assert.equal((await f.store.list('alice')).length, 5);
  await f.service.remove('alice', 'movie', 1);
  await f.service.add('alice', 'movie', 6, 'en-US');
  assert.equal((await f.store.list('alice')).length, 5);
});

test('new entries are immediately due and enqueue a worker wake, existing entries retain their status', async () => {
  const f = fixture();
  let wakes = 0;
  f.service.wake = () => {
    wakes++;
  };
  await f.service.add('alice', 'movie', 1, 'en-US');
  assert.equal(wakes, 1);
  assert.equal(f.rows.get('alice')![0]!.nextRunAt.toISOString(), '2026-10-26T00:00:00.000Z');
  await f.service.add('alice', 'movie', 1, 'en-US');
  assert.equal(wakes, 1);
});

test('worker checks latest channels before searching and skips a user with no channel', async () => {
  const f = fixture();
  await f.add();
  f.configured.set('one', false);
  f.configured.set('two', false);
  const worker = new ResourceNotificationWorker(f.service);
  await worker.tick();
  assert.equal(f.searches(), 0);
  assert.equal(f.rows.get('alice')![0]!.lastOutcome, 'no-channels');
  f.advance();
  f.configured.set('two', true);
  await worker.tick();
  assert.deepEqual(
    f.sent.map((item) => item.channel),
    ['two']
  );
  await worker.stop();
});

test('at least one success marks notified, attempts all channels, and future ticks skip notified entries', async () => {
  const f = fixture();
  await f.add();
  f.failures.add('two');
  const worker = new ResourceNotificationWorker(f.service);
  await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.locale, 'en-US');
  assert.equal(f.rows.get('alice')![0]!.status, 'notified');
  assert.equal(f.rows.get('alice')![0]!.lastOutcome, 'notified');
  assert.ok(f.logs.length > 0, 'errors must be logged with verbose disabled');
  f.advance();
  await worker.tick();
  assert.equal(f.searches(), 1);
  await worker.stop();
});

test('all delivery failures stay pending and retry only when the global interval is due', async () => {
  const f = fixture();
  await f.add();
  f.failures.add('one');
  f.failures.add('two');
  const worker = new ResourceNotificationWorker(f.service);
  await worker.tick();
  assert.equal(f.rows.get('alice')![0]!.lastOutcome, 'failed');
  assert.equal(f.rows.get('alice')![0]!.status, 'pending');
  await worker.tick();
  assert.equal(f.searches(), 1);
  f.failures.clear();
  f.advance();
  await worker.tick();
  assert.equal(f.sent.length, 2);
  await worker.stop();
});

test('channels removed during a search are re-read before delivery', async () => {
  const f = fixture();
  await f.add();
  const search = f.dependencies.search.search;
  f.dependencies.search.search = async (...args) => {
    f.configured.set('one', false);
    f.configured.set('two', false);
    return search(...args);
  };
  await new ResourceNotificationWorker(f.service).tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.rows.get('alice')![0]!.lastOutcome, 'no-channels');
});

test('a failed site does not prevent matching later sites and cross-user sends keep the owner', async () => {
  const f = fixture();
  await f.add('bob', 2, 'tv');
  f.dependencies.enabledSites = async () => ['broken', 'working'];
  const search = f.dependencies.search.search;
  f.dependencies.search.search = async (...args) => {
    if (args[1] === 'broken') throw new Error('site unavailable');
    return search(...args);
  };
  await new ResourceNotificationWorker(f.service).tick();
  assert.deepEqual(
    f.sent.map((item) => item.ownerId),
    ['bob', 'bob']
  );
});

test('search failure is retained as failed and missing identities never trigger broad movie matching', async () => {
  const f = fixture();
  await f.add();
  f.dependencies.search.search = async () => {
    throw new Error('offline');
  };
  const worker = new ResourceNotificationWorker(f.service);
  await worker.tick();
  assert.equal(f.rows.get('alice')![0]!.lastOutcome, 'failed');
  f.advance();
  f.dependencies.movies.readMovieDetail = async () => null;
  await worker.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.rows.get('alice')![0]!.lastOutcome, 'no-resources');
});

test('search traverses valid later pages and filters movie IMDb mismatches and dead releases', async () => {
  const f = fixture();
  await f.add();
  const pages: number[] = [];
  f.dependencies.search.search = async (_owner, _site, input) => {
    pages.push(input.page!);
    return input.page === 1
      ? {
          releases: [
            { id: 'wrong', title: 'Wrong', imdbId: 'tt7654321', seeders: 4 },
            { id: 'dead', title: 'Dead', seeders: 0 },
          ],
          nextPage: 2,
        }
      : { releases: [{ id: 'valid', title: 'Valid', imdbId: 'tt1234567', seeders: 2 }] };
  };
  await new ResourceNotificationWorker(f.service).tick();
  assert.deepEqual(pages, [1, 2]);
  assert.equal(f.sent.length, 2);
});

test('removing and re-adding during search invalidates the old claim before delivery', async () => {
  const f = fixture();
  await f.add();
  const search = f.dependencies.search.search;
  let changed = false;
  f.dependencies.search.search = async (...args) => {
    if (!changed) {
      changed = true;
      await f.store.remove('alice', 'movie', 1);
      const replacement = createResourceNotification('movie', 1, 'New', new Date('2026-10-27T00:00:00Z'));
      await f.store.add('alice', replacement);
    }
    return search(...args);
  };
  await new ResourceNotificationWorker(f.service).tick();
  assert.equal(f.sent.length, 0);
});

test('conservative TV matching rejects similar titles, movie-only names and dead resources', () => {
  const release = (title: string, seeders = 1): ResourceSiteRelease => ({ id: 'one', title, seeders });
  assert.equal(matchesTvResource(release('Some.Show.S01E02.1080p'), ['Some Show']), true);
  assert.equal(matchesTvResource(release('Some Show 2026 Season 2'), ['Some Show']), true);
  assert.equal(matchesTvResource(release('Some Show Extra S01E02'), ['Some Show']), false);
  assert.equal(matchesTvResource(release('Some Show 2026 1080p'), ['Some Show']), false);
  assert.equal(matchesTvResource(release('Some Show S01', 0), ['Some Show']), false);
});

test('persisted correlation IDs connect the API enqueue with worker logs and retry attempts', async () => {
  const f = fixture();
  f.dependencies.verbose = true;
  f.dependencies.logger.info = (value: unknown) => {
    f.logs.push(value);
  };
  await withAiTrace(
    new AiTrace(f.dependencies.logger, { correlationId: 'request-correlation' }, '', 'test', true),
    () => f.service.add('alice', 'movie', 1, 'en-US')
  );
  assert.equal(f.rows.get('alice')![0]!.correlationId, 'request-correlation');
  await new ResourceNotificationWorker(f.service).tick();
  assert.ok(
    f.logs.some((value) => {
      const fields = value as { correlationId?: string; attempt?: number };
      return fields.correlationId === 'request-correlation' && fields.attempt === 1;
    })
  );
});
