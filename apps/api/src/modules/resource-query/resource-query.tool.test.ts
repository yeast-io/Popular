import assert from 'node:assert/strict';
import test from 'node:test';
import { ResourceQueryTool } from './resource-query.tool.js';
import { emptyResourceState } from './resource-query.domain.js';
import type { ResourceQueryState, ResourceQueryStore, ResourcePlan, ResourceProvider } from './resource-query.types.js';
import type { MovieCatalogStore, MovieDetailRecord, MovieSearchProvider } from '../movies/movie.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';

class MemoryStore implements ResourceQueryStore {
  rows = new Map<string, ResourceQueryState>();
  leases = new Map<string, string>();
  key(ownerId: string, conversation: string) { return JSON.stringify([ownerId, conversation]); }
  async ensure(ownerId: string, conversation: string) {
    const key = this.key(ownerId, conversation);
    if (!this.rows.has(key)) this.rows.set(key, emptyResourceState());
  }
  async read(ownerId: string, conversation: string) {
    return structuredClone(this.rows.get(this.key(ownerId, conversation)) ?? null);
  }
  async acquire(ownerId: string, conversation: string, leaseId: string) {
    const key = this.key(ownerId, conversation);
    if (this.leases.has(key)) return false;
    this.leases.set(key, leaseId);
    return true;
  }
  async save(ownerId: string, conversation: string, leaseId: string, state: ResourceQueryState) {
    const key = this.key(ownerId, conversation);
    if (this.leases.get(key) !== leaseId) return false;
    this.rows.set(key, structuredClone(state));
    return true;
  }
  async release(ownerId: string, conversation: string, leaseId: string) {
    const key = this.key(ownerId, conversation);
    if (this.leases.get(key) === leaseId) this.leases.delete(key);
  }
}
const movie: MovieDetailRecord = {
  tmdbId: 157336, title: '星际穿越', originalTitle: 'Interstellar', releaseDate: '2014-11-05',
  genreIds: [], genres: [], cast: [], directors: [], imdbId: 'tt0816692',
};
const defaults: ResourcePlan = {
  title: '星际穿越', year: null, candidateId: null, resolution: null,
  providers: null, releaseIndex: null, page: null, refresh: false, question: null, unsupported: [],
};
function fixture(sources?: ResourceProvider[]) {
  const store = new MemoryStore();
  let searches = 0, queries = 0, persisted = 0;
  const observedOwners: string[] = [];
  const provider: ResourceProvider = {
    id: 'mteam', name: 'M-Team',
    query: async (ownerId) => {
      queries++;
      observedOwners.push(ownerId);
      return { provider: 'mteam', status: 'available', queriedAt: '2026-10-19T00:00:00.000Z', cached: true, releases: [
        { provider: 'mteam', id: '11', title: 'Interstellar.1080p', resolution: '1080p', seeders: 20 },
        { provider: 'mteam', id: '12', title: 'Interstellar.2160p', resolution: '2160p', sizeBytes: 1024 ** 3, seeders: 3 },
      ] };
    },
  };
  const movies: MovieSearchProvider = {
    search: async () => {
      searches++;
      return { movies: [movie], page: 1, totalPages: 1, totalResults: 1 };
    },
    fetchDetails: async (tmdbId) => ({ ...movie, tmdbId }),
  };
  const catalog = { writeMovieDetail: async () => { persisted++; } } as unknown as MovieCatalogStore;
  const tool = new ResourceQueryTool(store, sources ?? [provider], movies, catalog, 'zh-CN');
  const run = (plan: Partial<ResourcePlan> = {}, eventId = 'm1', ownerId = 'alice', conversation = 'web:thread') => {
    return tool.run(ownerId, conversation, eventId, 'query', [], { plan: async () => ({ ...defaults, ...plan }) });
  };
  return { store, tool, run, movies, provider, catalog, observedOwners,
    counts: () => ({ searches, queries, persisted }) };
}

test('queries real provider data, persists identity and replays a message without new external calls', async () => {
  const f = fixture();
  const result = await f.run();
  assert.match(result.replyText, /M-Team · 本次返回 2 条/);
  assert.match(result.replyText, /缓存/);
  assert.match(result.replyText, /【1】 1080p · 未知发布组/);
  assert.match(result.replyText, /【2】 4K · 未知发布组/);
  assert.equal((await f.run()).replyText, result.replyText);
  assert.deepEqual(f.counts(), { searches: 1, queries: 1, persisted: 1 });
});

test('follow-up resolution and numbered release inspections use saved server context across instances', async () => {
  const f = fixture();
  await f.run();
  const other = new ResourceQueryTool(f.store, [f.provider], f.movies, f.catalog, 'zh-CN');
  const filtered = await other.run('alice', 'web:thread', 'm2', '只看4K', [], {
    plan: async (_text, _history, context) => {
      assert.equal(context.movie?.tmdbId, movie.tmdbId);
      return { ...defaults, title: null, resolution: '2160p' };
    },
  }
  );
  assert.match(filtered.replyText, /1 个资源 · 4K/);
  assert.doesNotMatch(filtered.replyText, /1080p/);
  const inspected = await f.run({ title: null, releaseIndex: 1 }, 'm3');
  assert.match(inspected.replyText, /ID: 12/);
  assert.equal(f.counts().queries, 1);
});

test('same-name films require selection and hallucinated candidate IDs cannot reach a provider', async () => {
  const f = fixture();
  f.movies.search = async () => {
    return ({
      movies: [movie, { ...movie, tmdbId: 2, releaseDate: '2020-01-01' }], page: 1, totalPages: 1, totalResults: 2,
    });
  };
  assert.match((await f.run()).replyText, /请选择电影/);
  assert.equal(f.counts().queries, 0);
  assert.match((await f.run({ title: null, candidateId: 999 }, 'm2')).replyText, /不在当前候选/);
  assert.equal(f.counts().queries, 0);
  assert.match((await f.run({ title: null, candidateId: 2 }, 'm3')).replyText, /M-Team · 本次返回 2 条/);
});

test('partial provider failure preserves other sources and errors are not reported as no results', async () => {
  const f = fixture();
  const broken: ResourceProvider = {
    id: 'other', name: 'Other', query: async () => { throw new Error('upstream timed out'); },
  };
  const tool = new ResourceQueryTool(f.store, [f.provider, broken], f.movies, f.catalog, 'zh-CN');
  const result = await tool.run('alice', 'web:thread', 'm1', 'query', [], { plan: async () => defaults });
  assert.match(result.replyText, /【1】 \[M-Team\] 1080p/);
  assert.match(result.replyText, /Other · 查询失败，无法判断有无资源/);
  const g = fixture([broken]);
  const failure = await g.run();
  assert.match(failure.replyText, /查询失败/);
  assert.doesNotMatch(failure.replyText, /没有符合|未找到可用/);
});

test('not configured, no results and unmatchable remain distinct', async () => {
  for (const status of ['not_configured', 'unavailable', 'unmatchable'] as const) {
    const f = fixture([{
      id: 'other', name: 'Other', query: async () => {
        if (status === 'not_configured') throw new AppError(409, 'MTEAM_NOT_CONFIGURED', 'Configure M-Team');
        return { provider: 'other', status, releases: [] };
      },
    }]
    );
    const reply = (await f.run()).replyText;
    assert.match(reply, { not_configured: /尚未配置/, unavailable: /未找到可用资源/, unmatchable: /无法可靠匹配电影/ }[status]);
  }
});

test('owner and conversation isolate selections, filters and message replay', async () => {
  const f = fixture();
  await f.run({ resolution: '2160p' });
  assert.match((await f.run({ title: null }, 'm1', 'bob')).replyText, /请提供/);
  assert.match((await f.run({ title: null }, 'm2', 'alice', 'telegram:thread')).replyText, /请提供/);
  await f.run({}, 'm2', 'bob');
  assert.deepEqual(f.observedOwners, ['alice', 'bob']);
});

test('expired contexts cannot resolve old numbers, unsupported sources do not query', async () => {
  const f = fixture();
  await f.run();
  const state = await f.store.read('alice', 'web:thread');
  state!.updatedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  f.store.rows.set(f.store.key('alice', 'web:thread'), state!);
  assert.equal(await f.tool.active('alice', 'web:thread'), false);
  assert.match((await f.run({ title: null, releaseIndex: 1 }, 'm2')).replyText, /无效或已过期/);
  assert.match((await f.run({ providers: ['invented'] }, 'm3')).replyText, /尚未接入/);
  assert.equal(f.counts().queries, 1);
});

test('concurrent requests cannot overwrite a leased conversation and abort never saves state', async () => {
  const f = fixture();
  await f.store.ensure('alice', 'web:thread');
  await f.store.acquire('alice', 'web:thread', 'another-worker');
  await assert.rejects(f.run(), /busy/);
  assert.equal(f.store.leases.get(f.store.key('alice', 'web:thread')), 'another-worker');
  await f.store.release('alice', 'web:thread', 'another-worker');
  const controller = new AbortController();
  await assert.rejects(f.tool.run('alice', 'web:thread', 'm2', 'query', [], {
    plan: async () => { controller.abort(); return defaults; },
  }, controller.signal
  ), /abort/i
  );
  assert.equal((await f.store.read('alice', 'web:thread'))!.events.length, 0);
  assert.equal(f.store.leases.size, 0);
});

test('diagnostics preserve correlation and original cause with verbose disabled', async () => {
  const errors: Record<string, unknown>[] = [];
  const infos: unknown[] = [];
  const logger = { error: (data: Record<string, unknown>) => {
    return errors.push(data);
  }, info: (data: unknown) => {
    return infos.push(data);
  } };
  const f = fixture();
  const source: ResourceProvider = { id: 'broken', name: 'Broken', query: async () => {
    throw new Error('query failed', { cause: new Error('Bearer secret-token') });
  } };
  const tool = new ResourceQueryTool(f.store, [source], f.movies, f.catalog, 'zh-CN', { logger, verbose: false });
  await withAiTrace(new AiTrace(logger, { correlationId: 'trace-123' }, '', 'test', false), () => {
    return tool.run('alice', 'web:thread', 'm1', 'private conversation', [], { plan: async () => defaults });
  });
  assert.equal(infos.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.correlationId, 'trace-123');
  assert.equal(errors[0]?.stage, 'resources.provider.query');
  assert.match(JSON.stringify(errors), /cause/);
  assert.match(JSON.stringify(errors), /stack/);
  assert.doesNotMatch(JSON.stringify(errors), /secret-token|private conversation/);
});

test('fuzzy or incomplete search pages never silently choose their first match', async () => {
  for (const totalPages of [1, 2]) {
    const f = fixture();
    f.movies.search = async () => ({ movies: [movie], page: 1, totalPages, totalResults: totalPages });
    const result = await f.run({ title: totalPages === 1 ? 'Some ambiguous alias' : movie.title });
    assert.match(result.replyText, /请选择电影/);
    assert.equal(f.counts().queries, 0);
  }
});

test('a provider without torrent metadata can coexist with identical release IDs from other sources', async () => {
  const f = fixture();
  const source: ResourceProvider = { id: 'archive', name: 'Archive', query: async () => {
    return ({
      provider: 'archive', status: 'available', releases: [{ provider: 'archive', id: '11', title: 'Archive copy 4K' }],
    });
  } };
  const tool = new ResourceQueryTool(f.store, [f.provider, source], f.movies, f.catalog, 'zh-CN');
  const reply = await tool.run('alice', 'web:thread', 'm1', 'query', [], {
    plan: async () => ({ ...defaults, resolution: '2160p' }),
  }
  );
  assert.match(reply.replyText, /\[M-Team\] 4K/);
  assert.match(reply.replyText, /\[Archive\] 4K/);
  const state = await f.store.read('alice', 'web:thread');
  assert.deepEqual(state?.releases.map(({ provider, id }) => [provider, id]), [['mteam', '12'], ['archive', '11']]);
});

function pagedFixture() {
  const f = fixture();
  let calls = 0;
  let refreshed = false;
  f.provider.query = async (_owner, _movie, _signal, options) => {
    calls++;
    refreshed = options?.refresh ?? false;
    return {
      provider: 'mteam', status: 'available', releases: Array.from({ length: 62 }, (_, i) => {
        return ({
          provider: 'mteam', id: String(i + 1).padStart(2, '0'),
          title: `Full.Movie.Version.${i + 1}.${i % 2 ? '2160p' : '1080p'}.x265-FRDS`,
          seeders: refreshed && i === 61 ? 999 : 62 - i,
          sizeBytes: 1024 ** 3,
        });
      }).reverse(),
    };
  };
  return { ...f, calls: () => calls, refreshed: () => refreshed };
}

test('62 resources sort by seeders before paging; each page has ten continuous global numbers', async () => {
  const f = pagedFixture();
  const first = await f.run();
  assert.match(first.replyText, /M-Team · 本次返回 62 条/);
  assert.match(first.replyText, /第 1\/7 页/);
  assert.match(first.replyText, /【1】 1080p · FRDS · 1.00 GiB · 做种 62/);
  assert.match(first.replyText, /【10】 4K · FRDS · 1.00 GiB · 做种 53/);
  assert.doesNotMatch(first.replyText, /Full.Movie.Version|ID:|T00:|【11】 /);
  assert.equal(first.replyText.match(/^【\d+】 /gm)?.length, 10);
  const second = await f.run({ title: null, page: 'next' }, 'm2');
  assert.match(second.replyText, /第 2\/7 页/);
  assert.match(second.replyText, /【11】 1080p .*做种 52/);
  assert.match(second.replyText, /【20】 4K .*做种 43/);
  assert.equal(second.replyText.match(/^【\d+】 /gm)?.length, 10);
  const detail = await f.run({ title: null, releaseIndex: 12 }, 'm3');
  assert.match(detail.replyText, /Full.Movie.Version.12.2160p.x265-FRDS/);
  assert.match(detail.replyText, /ID: 12/);
  const last = await f.run({ title: null, page: 7 }, 'm4');
  assert.match(last.replyText, /【61】 1080p .*做种 2/);
  assert.match(last.replyText, /【62】 4K .*做种 1/);
  assert.equal(last.replyText.match(/^【\d+】 /gm)?.length, 2);
  assert.doesNotMatch(last.replyText, /回复“下一页”/);
  assert.match((await f.run({ title: null, page: 'next' }, 'm5')).replyText, /没有该页/);
  assert.match((await f.run({ title: null, page: 'previous' }, 'm6')).replyText, /第 6\/7 页/);
  assert.equal(f.calls(), 1);
  assert.equal(f.counts().searches, 1);
});

test('snapshot filtering returns to page one, keeps stable indices and never re-queries providers', async () => {
  const f = pagedFixture();
  await f.run();
  await f.run({ title: null, page: 'next' }, 'm2');
  const reply = await f.run({ title: null, resolution: '2160p' }, 'm3');
  assert.match(reply.replyText, /31 个资源 · 4K · 第 1\/4 页/);
  assert.match(reply.replyText, /【1】 4K .*做种 61/);
  assert.doesNotMatch(reply.replyText, /1080p/);
  assert.match((await f.run({ title: null, releaseIndex: 1 }, 'm4')).replyText, /ID: 02/);
  assert.equal(f.calls(), 1);
  const reset = await f.run({ title: null, resolution: 'any' }, 'm5');
  assert.match(reset.replyText, /62 个资源 · 第 1\/7 页/);
  assert.equal(f.calls(), 1);
});

test('explicit refresh bypasses source caches and starts page one in a newly sorted snapshot', async () => {
  const f = pagedFixture();
  await f.run();
  await f.run({ title: null, page: 3 }, 'm2');
  const refreshed = await f.run({ title: null, refresh: true }, 'm3');
  assert.equal(f.refreshed(), true);
  assert.equal(f.calls(), 2);
  assert.match(refreshed.replyText, /第 1\/7 页/);
  assert.match(refreshed.replyText, /【1】 4K .*做种 999/);
  assert.match((await f.run({ title: null, releaseIndex: 1 }, 'm4')).replyText, /ID: 62/);
  assert.equal((await f.run({ title: null, refresh: true }, 'm3')).replyText, refreshed.replyText);
  assert.equal(f.calls(), 2);
});

test('paging does not extend snapshot freshness and old persisted lists require a new query', async () => {
  const f = pagedFixture();
  await f.run();
  const state = (await f.store.read('alice', 'web:thread'))!;
  state.snapshot!.createdAt = new Date(Date.now() - 31 * 60_000).toISOString();
  state.updatedAt = new Date().toISOString();
  f.store.rows.set(f.store.key('alice', 'web:thread'), state);
  assert.match((await f.run({ title: null, page: 'next' }, 'm2')).replyText, /已过期/);
  assert.match((await f.run({ title: null, releaseIndex: 1 }, 'm3')).replyText, /已过期/);
  assert.equal(f.calls(), 1);
  const expired = (await f.store.read('alice', 'web:thread'))!;
  delete expired.snapshot;
  f.store.rows.set(f.store.key('alice', 'web:thread'), expired);
  assert.match((await f.run({ title: null, page: 1 }, 'm4')).replyText, /无效或已过期/);
  assert.match((await f.run({ title: null, refresh: true }, 'm5')).replyText, /第 1\/7 页/);
  assert.equal(f.calls(), 2);
});

test('empty filtered snapshots give a clear paging response and remain reusable when filters are cleared', async () => {
  const f = pagedFixture();
  await f.run({ resolution: '720p' });
  assert.match((await f.run({ title: null, page: 'next' }, 'm2')).replyText, /没有可分页的资源/);
  assert.match((await f.run({ title: null, resolution: 'any' }, 'm3')).replyText, /62 个资源.*第 1\/7 页/);
  assert.equal(f.calls(), 1);
});

test('a failed source is queried again on a new interaction rather than reused as a successful snapshot', async () => {
  const f = fixture();
  let calls = 0;
  f.provider.query = async () => {
    calls++;
    if (calls === 1) throw new AppError(504, 'MTEAM_TIMEOUT', 'query timed out');
    return { provider: 'mteam', status: 'available', releases: [{ provider: 'mteam', id: 'new', title: 'Film 4K-FRDS', seeders: 9 }] };
  };
  assert.match((await f.run()).replyText, /查询失败/);
  assert.match((await f.run({ title: null }, 'm2')).replyText, /【1】 4K · FRDS/);
  assert.equal(calls, 2);
  // Delivery replay of a prior failure remains stable; it is not a new user query.
  assert.match((await f.run({}, 'm1')).replyText, /查询失败/);
  assert.equal(calls, 2);
});

test('retrying a partially failed snapshot preserves successful sources and their original freshness', async () => {
  const f = fixture();
  let otherCalls = 0;
  const other: ResourceProvider = { id: 'other', name: 'Other', query: async () => {
    otherCalls++;
    if (otherCalls === 1) throw new AppError(504, 'MTEAM_TIMEOUT', 'query timed out');
    return { provider: 'other', status: 'available', releases: [{ provider: 'other', id: 'other1', title: 'Other 4K', seeders: 10 }] };
  } };
  const tool = new ResourceQueryTool(f.store, [f.provider, other], f.movies, f.catalog, 'zh-CN');
  await tool.run('alice', 'web:thread', 'm1', 'query', [], { plan: async () => defaults });
  const state = (await f.store.read('alice', 'web:thread'))!;
  const originalTime = new Date(Date.now() - 60_000).toISOString();
  state.snapshot!.createdAt = originalTime;
  f.store.rows.set(f.store.key('alice', 'web:thread'), state);
  const reply = await tool.run('alice', 'web:thread', 'm2', 'retry query', [], {
    plan: async () => ({ ...defaults, title: null }),
  }
  );
  assert.match(reply.replyText, /Other · 本次返回 1 条/);
  assert.doesNotMatch(reply.replyText, /查询失败/);
  assert.equal(f.counts().queries, 1);
  assert.equal(otherCalls, 2);
  assert.equal((await f.store.read('alice', 'web:thread'))?.snapshot?.createdAt, originalTime);
});

test('per-turn locale overrides the shared resource tool default without leaking across conversations', async () => {
  const f = fixture();
  const [english, chinese] = await Promise.all([
    f.tool.run(
      'alice', 'telegram:english', 'en1', 'find Interstellar',
      [],
      { plan: async () => ({ ...defaults }) },
      undefined, 'en-US'
    ),
    f.tool.run(
      'alice', 'telegram:chinese', 'zh1', '查询星际穿越',
      [],
      { plan: async () => ({ ...defaults }) },
      undefined, 'zh-CN'
    ),
  ]
  );
  assert.match(english.replyText, /releases returned/);
  assert.match(english.replyText, /Reply “details/);
  assert.doesNotMatch(english.replyText, /回复|未知发布组|本次返回/);
  assert.match(chinese.replyText, /本次返回/);
  const detail = await f.tool.run('alice', 'telegram:english', 'en2', 'details 2', [], {
    plan: async (_text, _history, _context, locale) => {
      assert.equal(locale, 'en-US');
      return { ...defaults, title: null, releaseIndex: 2 };
    },
  }, undefined, 'en-US'
  );
  assert.match(detail.replyText, /Release 2 · previous query/);
});

for (const locale of ['zh-CN', 'en-US'] as const) {
  test(`page two uses clearly separated release labels with unchanged global numbers (${locale})`, async () => {
    const f = fixture();
    f.provider.query = async () => {
      return ({
        provider: 'mteam', status: 'available', releases: Array.from({ length: 20 }, (_, index) => {
          return ({
            provider: 'mteam', id: String(index + 1), title: 'Movie.2160p-WiKi',
            resolution: '2160p', seeders: 20 - index,
          });
        }),
      });
    };
    await f.tool.run(
      'alice', 'whatsapp:chat', 'first', 'find resources',
      [],
      { plan: async () => defaults },
      undefined, locale
    );
    const second = await f.tool.run('alice', 'whatsapp:chat', 'second', 'next page', [], {
      plan: async () => ({ ...defaults, title: null, page: 'next' }),
    }, undefined, locale
    );
    assert.match(second.replyText, /^【11】 4K · WiKi/m);
    assert.match(second.replyText, /^【20】 4K · WiKi/m);
    assert.equal(second.replyText.match(/^【\d+】 /gm)?.length, 10);
    assert.doesNotMatch(second.replyText, /^\d+\.\s*4K/m);
    const state = await f.store.read('alice', 'whatsapp:chat');
    assert.equal(state?.releases[2]?.id, '3');
    assert.equal(state?.releases[10]?.id, '11');
  });
}
