import { randomUUID } from 'node:crypto';
import type { Locale } from '@movie-hub/contract';
import type { LlmClient, LlmMessage } from '../llm/llm.types.js';
import type { MovieCatalogStore, MovieDetailRecord, MovieRecord, MovieStatusStore } from '../movies/movie.types.js';
import type { DiscoveryProvider, RecommendationProfileReader, RecommendationStore } from './recommendation.types.js';
import { RECOMMENDATION_GENRE_IDS, emptyRecommendationState } from './recommendation.domain.js';
import { RecommendationAgent } from './agents/recommendation.agent.js';

export class RecommendationWorkflow {
  constructor(
    private readonly store: RecommendationStore,
    private readonly profiles: RecommendationProfileReader,
    private readonly provider: DiscoveryProvider,
    private readonly catalog: MovieCatalogStore,
    private readonly statuses: MovieStatusStore,
    private readonly locale: Locale,
    private readonly maxContextTokens = 32_000
  ) {}
  async active(ownerId: string, conversation: string) {
    const row = await this.store.read(ownerId, conversation);
    return Boolean(row?.state.active);
  }
  async run(ownerId: string, conversation: string, eventId: string, text: string, history: LlmMessage[], llm: Pick<LlmClient, 'generate'>, signal?: AbortSignal): Promise<string> {
    const leaseId = randomUUID();
    await this.store.ensure(ownerId, conversation);
    if (!await this.store.acquire(ownerId, conversation, leaseId)) throw new Error('Recommendation conversation is busy');
    const deadline = AbortSignal.timeout(180_000);
    try { return await this.execute(ownerId, conversation, eventId, text, history, llm, leaseId, signal ? AbortSignal.any([signal, deadline]) : deadline); }
    finally { await this.store.release(ownerId, conversation, leaseId); }
  }
  private async execute(ownerId: string, conversation: string, eventId: string, text: string, history: LlmMessage[], llm: Pick<LlmClient, 'generate'>, leaseId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const row = await this.store.read(ownerId, conversation);
    const state = row?.state ?? emptyRecommendationState();
    if (state.events[eventId]) return state.events[eventId];
    if (row && Date.now() - row.updatedAt.getTime() > 30 * 60_000) { state.active = false; state.questions = 0; state.history = []; }
    const profile = await this.profiles.read(ownerId);
    const agent = new RecommendationAgent(llm, this.maxContextTokens);
    const combined = state.active ? [...state.history, { role: 'user' as const, content: text }] : [...history.slice(-6), { role: 'user' as const, content: text }];
    const immediate = /先推荐|立即推荐|直接推荐|马上推荐|别问|不要再问|just recommend|recommend now|stop asking|no more questions/i.test(text);
    const plan = await agent.plan(profile, state.active ? state.questions : 0, immediate, combined.slice(-12), signal);
    signal.throwIfAborted();
    if ([...plan.genres, ...plan.excludeGenres].some(id => !RECOMMENDATION_GENRE_IDS.includes(id))) throw new Error('Unknown genre filter');
    let reply: string;
    if (plan.question && !immediate && (state.active ? state.questions : 0) < 3) {
      state.questions = (state.active ? state.questions : 0) + 1;
      state.active = true; reply = plan.question;
      state.history = [...combined, { role: 'assistant' as const, content: reply }].slice(-12);
    } else if (plan.unverifiableRestrictions.length) {
      reply = `目前的电影资料无法可靠核实这些硬性限制：${plan.unverifiableRestrictions.join('、')}。本次不返回未经核实的推荐。`;
      state.active = false; state.questions = 0; state.history = [];
    } else {
      const filters = { genres: plan.genres.filter(id => RECOMMENDATION_GENRE_IDS.includes(id)), excludeGenres: plan.excludeGenres.filter(id => RECOMMENDATION_GENRE_IDS.includes(id)), maxRuntime: plan.maxRuntime, language: plan.language };
      let candidates: MovieRecord[] = [];
      if (plan.referenceTitle) {
        const search = await this.provider.search(plan.referenceTitle, 1, this.locale, { actorType: 'user', ownerId, trigger: 'api_request' });
        if (search.movies[0]) candidates.push(...await this.provider.related(search.movies[0].tmdbId, this.locale, ownerId));
      } else {
        const liked = await this.statuses.list(ownerId, 'liked', 1, 2);
        for (const movie of liked.items) {
          signal.throwIfAborted();
          candidates.push(...await this.provider.related(movie.tmdbId, this.locale, ownerId));
        }
      }
      for (let page = 1; page <= 2; page++) candidates.push(...await this.provider.discover(filters, page, this.locale, ownerId));
      candidates = [...new Map(candidates.map(movie => [movie.tmdbId, movie])).values()];
      const states = await this.statuses.readForMovies(ownerId, candidates.map(movie => movie.tmdbId));
      const excluded = new Set(states.filter(item => item.status === 'watched' || item.preference === 'disliked').map(item => item.tmdbId));
      const recent = new Set(state.batches.slice(-3).flatMap(batch => batch.movieIds));
      candidates = candidates.filter(movie => !excluded.has(movie.tmdbId) && !recent.has(movie.tmdbId)
        && (!movie.releaseDate || movie.releaseDate <= new Date().toISOString().slice(0, 10))
        && filters.genres.every(id => movie.genreIds.includes(id)) && !filters.excludeGenres.some(id => movie.genreIds.includes(id)));
      const details: MovieDetailRecord[] = [];
      for (const movie of candidates.slice(0, 12)) {
        signal.throwIfAborted();
        const detail = await this.provider.fetchDetails(movie.tmdbId, this.locale, { actorType: 'user', ownerId, trigger: 'api_request' });
        if (filters.maxRuntime && (!detail.runtimeMinutes || detail.runtimeMinutes > filters.maxRuntime)) continue;
        if (filters.language && detail.originalLanguage !== filters.language) continue;
        await this.catalog.writeMovieDetail(detail, new Date(), this.locale);
        details.push(detail);
      }
      if (!details.length) reply = '本次没有找到符合条件、且尚未标记已看或不喜欢的电影。可以放宽条件后再试。';
      else {
        const ranked = await agent.rank(profile, combined.slice(-12), details, signal);
        const chosen = [...new Map(ranked.movies.map(item => [item.tmdbId, item])).values()];
        if (chosen.some(item => !details.some(movie => movie.tmdbId === item.tmdbId))) throw new Error('Unknown recommendation candidate');
        // Recheck mutable user state immediately before delivering the batch.
        const latest = await this.statuses.readForMovies(ownerId, chosen.map(item => item.tmdbId));
        const blocked = new Set(latest.filter(item => item.status === 'watched' || item.preference === 'disliked').map(item => item.tmdbId));
        const eligible = chosen.filter(item => !blocked.has(item.tmdbId));
        reply = eligible.map((item, index) => `${index + 1}. ${details.find(movie => movie.tmdbId === item.tmdbId)!.title}\n${item.reason}\nhttps://www.themoviedb.org/movie/${item.tmdbId}`).join('\n\n') || '没有足够证据支持符合本次限制的推荐，可以调整条件后再试。';
        state.batches = [...state.batches, { id: randomUUID(), movieIds: eligible.map(item => item.tmdbId), profileVersion: profile.version, at: new Date().toISOString() }].slice(-20);
      }
      state.active = false; state.questions = 0; state.history = [];
    }
    state.events = Object.fromEntries([...Object.entries(state.events), [eventId, reply]].slice(-50));
    signal.throwIfAborted();
    if (!await this.store.save(ownerId, conversation, leaseId, state)) throw new Error('Recommendation lease lost');
    return reply;
  }
}
