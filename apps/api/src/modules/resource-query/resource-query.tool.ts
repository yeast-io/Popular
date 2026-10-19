import { compactField, compareReleases, matchesResolution, releaseGroup, releaseResolution, RESOURCE_PAGE_SIZE } from './resource-query.presentation.js';
import { randomUUID } from 'node:crypto';
import type { Locale } from '@movie-hub/contract';
import { AiTrace, aiStep, currentAiTrace, withAiTrace, type AiLogger } from '../../infrastructure/logging/ai-trace.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { LlmMessage } from '../llm/llm.types.js';
import type { MovieCatalogStore, MovieRecord, MovieSearchProvider } from '../movies/movie.types.js';
import { userExternalRequestContext } from '../external-usage/external-usage.types.js';
import {
  emptyResourceState, RESOURCE_SESSION_MS,
  type ResourceDecisions, type ResourceMovie, type ResourceProvider, type ResourceQueryCapability,
  type ResourceQueryState, type ResourceQueryStore, type ResourceRelease, type ResourceSourceResult,
} from './resource-query.types.js';

export class ResourceQueryTool implements ResourceQueryCapability {
  private readonly sources: Map<string, ResourceProvider>;
  constructor(
    private readonly store: ResourceQueryStore,
    sources: ResourceProvider[],
    private readonly movies: MovieSearchProvider,
    private readonly catalog: MovieCatalogStore,
    private readonly locale: Locale,
    private readonly diagnostics: { logger?: AiLogger; verbose: boolean } = { verbose: false }
  ) {
    this.sources = new Map(sources.map((source) => [source.id, source]));
    if (this.sources.size !== sources.length || sources.some((source) => !/^[a-z][a-z0-9_-]{0,31}$/.test(source.id)))
      throw new Error('Resource providers require unique registry IDs');
  }
  async active(ownerId: string, conversation: string): Promise<boolean> {
    const state = await aiStep('resources.active.read', () => this.store.read(ownerId, conversation));
    return Boolean(state && isActive(state));
  }
  async run(
    ownerId: string, conversation: string, eventId: string, text: string,
    history: LlmMessage[], decisions: ResourceDecisions, signal?: AbortSignal,
  ): Promise<{ replyText: string }> {
    const trace = new AiTrace(this.diagnostics.logger, {
      correlationId: currentAiTrace()?.correlationId ?? randomUUID(), ownerId, eventId,
    }, text, 'resources.query', this.diagnostics.verbose);
    for (const message of history) trace.sensitive(message.content);
    return withAiTrace(trace, async () => {
      const leaseId = randomUUID();
      let acquired = false;
      let failure: { error: unknown } | undefined;
      let replyText = '';
      try {
        replyText = await aiStep('resources.run', async () => {
          signal?.throwIfAborted();
          await aiStep('resources.state.ensure', () => this.store.ensure(ownerId, conversation));
          acquired = await aiStep('resources.lease.acquire', () => this.store.acquire(ownerId, conversation, leaseId));
          if (!acquired) throw new Error('Resource query conversation is busy');
          const deadline = AbortSignal.timeout(120_000);
          const executionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
          const previous = await aiStep('resources.state.read', () => this.store.read(ownerId, conversation));
          const replay = previous?.events.find((event) => event.id === eventId);
          if (replay) {
            trace.event('resources.replay', { outcome: 'reused' });
            return replay.replyText;
          }
          const state = previous && isActive(previous) ? previous : emptyResourceState();
          // Keep bounded replay receipts even after the interactive context expires.
          state.events = previous?.events ?? [];
          const reply = await this.execute(ownerId, text, history, state, decisions, executionSignal);
          trace.sensitive(reply);
          executionSignal.throwIfAborted();
          state.updatedAt = new Date().toISOString();
          state.events = [...state.events, { id: eventId, replyText: reply }].slice(-20);
          const saved = await aiStep(
            'resources.state.save',
            () => this.store.save(ownerId, conversation, leaseId, state)
          );
          if (!saved) throw new Error('Resource query conversation lease lost');
          return reply;
        });
      } catch (error) {
        failure = { error };
        trace.fail(error);
      }
      if (acquired) {
        try {
          await aiStep('resources.lease.release', () => this.store.release(ownerId, conversation, leaseId));
        } catch (error) {
          trace.fail(error, { stage: 'resources.lease.release' });
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
      trace.event('resources.completed', { outcome: 'success' });
      return { replyText };
    });
  }
  private async execute(
    ownerId: string, text: string, history: LlmMessage[], state: ResourceQueryState,
    decisions: ResourceDecisions, signal: AbortSignal,
  ): Promise<string> {
    const zh = this.locale === 'zh-CN';
    const plan = await aiStep('resources.plan', () => {
      return decisions.plan(text, history, {
        candidates: state.candidates, movie: state.movie, resolution: state.resolution,
        providers: state.providers, sources: [...this.sources.values()].map(({ id, name }) => ({ id, name })),
        releaseCount: state.releases.length, page: state.page ?? 1,
        pageCount: Math.ceil(state.releases.length / RESOURCE_PAGE_SIZE),
      }, this.locale, signal
      );
    });
    signal.throwIfAborted();
    if (plan.unsupported.length)
      return zh ? '目前可按资源来源和画质筛选，其他条件暂时无法可靠核实。请调整查询条件。'
        : 'I can filter by source and resolution. Other conditions cannot be verified yet. Please adjust the filters.';
    if (plan.question) return plan.question;
    if (plan.providers?.some((id) => !this.sources.has(id)))
      return zh ? '该资源来源尚未接入。当前支持：' + [...this.sources.values()].map((s) => s.name).join('、')
        : 'Unsupported source. Available sources: ' + [...this.sources.values()].map((s) => s.name).join(', ');
    const changingQuery = Boolean(plan.title || plan.candidateId !== null || plan.resolution !== null || plan.providers !== null || plan.refresh);
    const hasSnapshot = Boolean(state.snapshot && Date.now() - Date.parse(state.snapshot.createdAt) < RESOURCE_SESSION_MS);
    if (plan.releaseIndex !== null || plan.page !== null) {
      if (changingQuery || (plan.releaseIndex !== null && plan.page !== null))
        return zh ? '请先明确是查看已有结果，还是重新查询或筛选。' : 'Choose whether to inspect the saved results or run a new query/filter.';
      if (!hasSnapshot)
        return zh ? '资源列表无效或已过期，请重新查询或发送“刷新资源”。' : 'The resource snapshot is missing or expired. Please query or refresh again.';
      if (plan.releaseIndex !== null) {
        const release = state.releases[plan.releaseIndex - 1];
        currentAiTrace()?.event('resources.snapshot.inspect', { releaseIndex: plan.releaseIndex, outcome: release ? 'success' : 'invalid_index' });
        return release ? this.releaseDetail(release, plan.releaseIndex)
          : zh ? `资源编号无效，本次结果共 ${state.releases.length} 条。` : `Invalid release number. This snapshot has ${state.releases.length} releases.`;
      }
      const page = plan.page === 'next' ? (state.page ?? 1) + 1 : plan.page === 'previous' ? (state.page ?? 1) - 1 : plan.page!;
      const pages = Math.ceil(state.releases.length / RESOURCE_PAGE_SIZE);
      if (!pages)
        return zh ? '当前查询没有可分页的资源，请调整筛选条件或刷新资源。' : 'This query has no releases to page through. Adjust the filters or refresh.';
      if (page < 1 || page > pages)
        return zh ? `当前为第 ${state.page ?? 1}/${pages} 页，没有该页。` : `Currently on page ${state.page ?? 1}/${pages}; that page does not exist.`;
      state.page = page;
      currentAiTrace()?.event('resources.snapshot.page', { page, pageCount: pages, outcome: 'reused' });
      return this.renderPage(state);
    }
    if (plan.candidateId !== null && plan.title)
      return zh ? '请明确是选择候选电影，还是查询另一部电影。' : 'Please choose a candidate or search for a different title.';
    if (plan.resolution !== null) state.resolution = plan.resolution;
    if (plan.providers !== null) state.providers = plan.providers;
    if (plan.candidateId !== null) {
      const candidate = state.candidates.find((movie) => movie.tmdbId === plan.candidateId);
      if (!candidate) return zh ? '该电影不在当前候选中，请提供片名和年份。' : 'Choose a current candidate or provide a title and year.';
      delete state.snapshot;
      state.page = 1;
      state.movie = candidate;
      state.candidates = [];
      state.releases = [];
    } else if (plan.title) {
      delete state.snapshot;
      state.page = 1;
      state.movie = null;
      state.candidates = [];
      state.releases = [];
      const found = await aiStep('resources.movie.search', () => {
        return this.movies.search(plan.title!, 1, this.locale, userExternalRequestContext(ownerId, 'api_request'));
      });
      signal.throwIfAborted();
      const matches = found.movies.filter((movie) => !plan.year || movie.releaseDate?.startsWith(String(plan.year)));
      const exact = matches.filter((movie) => {
        return [movie.title, movie.originalTitle].some(
          (title) => title && normalized(title) === normalized(plan.title!)
        );
      });
      // Never assume that the first search hit is the requested film.
      const selected = exact.length === 1 && found.totalPages <= 1 ? exact[0] : undefined;
      if (selected) state.movie = toResourceMovie(selected);
      else {
        state.candidates = matches.slice(0, 5).map(toResourceMovie);
        for (const movie of state.candidates) currentAiTrace()?.sensitive(movie.title);
        if (!state.candidates.length)
          return zh ? '未找到匹配电影，请提供更准确的片名和年份。' : 'No matching film found. Please provide a more precise title and year.';
        return (zh ? '请选择电影（回复序号或年份）；如不在列表中，请补充片名：\n' : 'Choose a film by number or year, or refine the title:\n') +
          state.candidates.map((movie, index) => `${index + 1}. ${movie.title} (${movie.year ?? '?'})`).join('\n');
      }
    }
    if (!state.movie)
      return zh ? '请提供要查资源的电影片名和年份，或选择上面的候选电影。' : 'Provide the film title and year, or choose a candidate above.';
    const movie = state.movie;
    currentAiTrace()?.sensitive(movie.title);
    if (state.providers.some((id) => !this.sources.has(id))) {
      state.providers = [];
      state.releases = [];
      return zh ? '之前选择的资源服务已不可用，请重新选择来源或查询全部来源。' : 'A previously selected source is no longer available. Choose a source again or query all sources.';
    }
    const providers = state.providers.length ? state.providers.map((id) => {
      return this.sources.get(id)!;
    }) : [...this.sources.values()];
    if (!providers.length) return zh ? '当前没有接入资源服务。' : 'No resource services are available.';
    // Failed sources are not reusable query results; successful sources in a partial snapshot remain useful.
    const reusable = !plan.refresh && hasSnapshot ? state.snapshot!.results.filter((result) => {
      return providers.some((provider) => provider.id === result.provider) &&
        ['available', 'unavailable', 'unmatchable'].includes(result.status);
    }) : [];
    if (reusable.length === providers.length) {
      this.applySnapshot(state);
      currentAiTrace()?.event('resources.snapshot.filter', { releaseCount: state.releases.length, outcome: 'reused' });
      return this.renderPage(state);
    }
    // Existing M-Team lookups require a catalog entry. Identity is obtained from TMDB, never from the model.
    const detail = await aiStep('resources.movie.detail', () => {
      return this.movies.fetchDetails(movie.tmdbId, this.locale, userExternalRequestContext(ownerId, 'api_request'));
    }, { tmdbId: movie.tmdbId });
    signal.throwIfAborted();
    if (detail.tmdbId !== movie.tmdbId) throw new Error('Movie detail identity did not match the selected film');
    await aiStep('resources.movie.persist', () => this.catalog.writeMovieDetail(detail, new Date(), this.locale));
    const results = await Promise.all(providers.map(async (source): Promise<ResourceSourceResult> => {
      const previous = reusable.find((result) => result.provider === source.id);
      if (previous) {
        currentAiTrace()?.event('resources.provider.result', { provider: source.id, outcome: 'reused' });
        return { ...previous, cached: true };
      }
      try {
        const result = await aiStep('resources.provider.query', () => {
          return source.query(ownerId, movie.tmdbId, signal, { refresh: plan.refresh });
        }, {
          provider: source.id, tmdbId: movie.tmdbId,
        }
        );
        signal.throwIfAborted();
        if (result.provider !== source.id || result.releases.some((release) => release.provider !== source.id))
          throw new Error('Resource provider returned mismatched source identity');
        currentAiTrace()?.event('resources.provider.result', {
          provider: source.id, outcome: result.status, releaseCount: result.releases.length, cached: Boolean(
            result.cached
          ),
        }
        );
        return result;
      } catch (error) {
        if (signal.aborted) throw error;
        // Reuse the diagnostic serializer; adapters must never expose raw credential payloads.
        const trace = currentAiTrace();
        const code = error instanceof AppError ? error.code : 'RESOURCE_QUERY_FAILED';
        trace?.fail(error, { stage: 'resources.provider.query', provider: source.id, outcome: 'failure' });
        trace?.clearFailure();
        return { provider: source.id, status: code.endsWith(
          '_NOT_CONFIGURED'
        ) ? 'not_configured' : 'error', errorCode: code, releases: [] };
      }
    }));
    signal.throwIfAborted();
    // Reusing a successful source must not extend its freshness when another source is retried.
    state.snapshot = { createdAt: reusable.length ? state.snapshot!.createdAt : new Date().toISOString(), results };
    this.applySnapshot(state);
    return this.renderPage(state);
  }
  private applySnapshot(state: ResourceQueryState): void {
    const releases = state.snapshot!.results.flatMap((result) => {
      if (result.status !== 'available' || (state.providers.length && !state.providers.includes(
        result.provider
      ))) return [];
      return result.releases.filter((release) => matchesResolution(release, state.resolution));
    });
    state.releases = [...new Map(releases.map((release) => {
      return [JSON.stringify([release.provider, release.id]), release];
    })).values()].sort(compareReleases);
    state.page = 1;
  }
  private renderPage(state: ResourceQueryState): string {
    const zh = this.locale === 'zh-CN';
    const movie = state.movie!;
    const results = state.snapshot!.results.filter((result) => {
      return !state.providers.length || state.providers.includes(result.provider);
    });
    const page = state.page ?? 1;
    const pages = Math.ceil(state.releases.length / RESOURCE_PAGE_SIZE);
    const heading = `${compactField(movie.title, 100)}（${movie.year ?? '?'}）`;
    const labels = zh
      ? { available: '找到资源', unavailable: '未找到可用资源', unmatchable: '无法可靠匹配电影', not_configured: '尚未配置', error: '查询失败，无法判断有无资源' }
      : { available: 'releases found', unavailable: 'no available releases', unmatchable: 'film identity could not be matched', not_configured: 'not configured', error: 'query failed; availability unknown' };
    const statuses = results.map((result) => {
      const name = compactField(this.sources.get(result.provider)?.name ?? result.provider, 32);
      return result.status === 'available'
        ? `${name} · ${zh ? `本次返回 ${result.releases.length} 条` : `${result.releases.length} releases returned`}${result.cached ? zh ? '（缓存）' : ' (cached)' : ''}`
        : `${name} · ${labels[result.status]}`;
    });
    const lines = state.releases.slice((page - 1) * RESOURCE_PAGE_SIZE, page * RESOURCE_PAGE_SIZE).map((release, offset) => {
      const index = (page - 1) * RESOURCE_PAGE_SIZE + offset + 1;
      const group = compactField(releaseGroup(release) ?? (zh ? '未知发布组' : 'unknown group'), 40);
      const source = results.length > 1 ? ` [${compactField(
        this.sources.get(release.provider)?.name ?? release.provider,
        32
      )}]` : '';
      const size = release.sizeBytes !== undefined ? `${(release.sizeBytes / 1024 ** 3).toFixed(
        2
      )} GiB` : zh ? '大小未知' : 'size unknown';
      const seeders = release.seeders !== undefined && Number.isFinite(
        release.seeders
      ) && release.seeders >= 0 ? release.seeders : zh ? '未知' : 'unknown';
      return `${index}.${source} ${releaseResolution(
        release
      ) ?? (zh ? '分辨率未知' : 'unknown resolution')} · ${group} · ${size} · ${zh ? '做种' : 'seeders'} ${seeders}`;
    });
    const filter = state.resolution && state.resolution !== 'any' ? ` · ${state.resolution === '2160p' ? '4K' : state.resolution}` : '';
    const count = zh ? `${state.releases.length} 个资源${filter} · 第 ${page}/${pages} 页` : `${state.releases.length} releases${filter} · page ${page}/${pages}`;
    const hints = zh
      ? [page < pages ? '回复“下一页”继续查看' : undefined, page > 1 ? '支持“上一页”或“第 1 页”' : undefined,
        `回复“详情 ${(page - 1) * RESOURCE_PAGE_SIZE + 1}”查看完整版本信息`, '支持“只看 4K”或“刷新资源”']
      : [page < pages ? 'Reply “next page” to continue' : undefined, page > 1 ? 'Use “previous page” or “page 1”' : undefined,
        `Reply “details ${(page - 1) * RESOURCE_PAGE_SIZE + 1}” for the full release name`, 'Use “only 4K” or “refresh resources”'];
    const noMatches = results.some((result) => result.status === 'available')
      ? zh ? '没有符合当前筛选条件的资源。' : 'No releases match the current filters.' : '';
    return [heading, ...statuses, state.releases.length ? count : noMatches, '', ...lines,
      ...(state.releases.length ? ['', ...hints.filter(Boolean)] : [])].filter((line) => {
        return line !== undefined;
      }).join('\n').trim();
  }
  private releaseDetail(release: ResourceRelease, index: number): string {
    const zh = this.locale === 'zh-CN';
    return [zh ? `资源 ${index} · 上次查询结果` : `Release ${index} · previous query`,
      compactField(this.sources.get(release.provider)?.name ?? release.provider, 32),
      // Keep the full filename in details; only control characters are removed.
      compactField(release.title, 3000),
      [releaseResolution(release), compactField(releaseGroup(release) ?? (zh ? '未知发布组' : 'unknown group'), 40),
        release.sizeBytes !== undefined ? `${(release.sizeBytes / 1024 ** 3).toFixed(2)} GiB` : undefined,
        release.seeders !== undefined ? `${zh ? '做种' : 'seeders'} ${release.seeders}` : undefined,
        `ID: ${compactField(release.id, 128)}`].filter(Boolean).join(' · '),
    ].join('\n');
  }
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
}
function toResourceMovie(movie: MovieRecord): ResourceMovie {
  const year = Number(movie.releaseDate?.slice(0, 4));
  return { tmdbId: movie.tmdbId, title: movie.title,
    ...(movie.originalTitle ? { originalTitle: movie.originalTitle } : {}),
    ...(year ? { year } : {}) };
}
function isActive(state: ResourceQueryState): boolean {
  return Date.now() - Date.parse(state.updatedAt) < RESOURCE_SESSION_MS;
}
