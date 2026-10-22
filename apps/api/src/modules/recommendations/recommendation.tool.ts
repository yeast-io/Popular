import { randomUUID } from 'node:crypto';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { profileText } from '../preferences/preference.domain.js';
import { RECOMMENDATION_POLICY as policy } from './recommendation.policy.js';
import { recommendationMessages } from './recommendation.messages.js';
import type { Locale } from '@movie-hub/contract';
import type { LlmMessage } from '../llm/llm.types.js';
import type { MovieCatalogStore, MovieDetailRecord, MovieRecord, MovieStatusStore } from '../movies/movie.types.js';
import type {
  DiscoveryProvider,
  RecommendationProfileReader,
  RecommendationStore,
  RecommendationResult,
  RecommendationMovie,
} from './recommendation.types.js';
import { RECOMMENDATION_GENRE_IDS, emptyRecommendationState, isRecommendationActive } from './recommendation.domain.js';
import type { RecommendationDecisions } from './recommendation.types.js';

export class RecommendationTool {
  constructor(
    private readonly store: RecommendationStore,
    private readonly profiles: RecommendationProfileReader,
    private readonly provider: DiscoveryProvider,
    private readonly catalog: MovieCatalogStore,
    private readonly statuses: MovieStatusStore,
    private readonly locale: Locale,
    private readonly diagnostics: { logger?: AiLogger; verbose: boolean } = { verbose: false }
  ) {}

  async active(ownerId: string, conversation: string) {
    const row = await aiStep('recommendation.active.read', () => {
      return this.store.read(ownerId, conversation);
    });
    return row ? isRecommendationActive(row.state) : false;
  }

  async run(
    ownerId: string,
    conversation: string,
    eventId: string,
    text: string,
    history: LlmMessage[],
    decisions: RecommendationDecisions,
    signal?: AbortSignal
  ): Promise<string> {
    return (await this.runResult(ownerId, conversation, eventId, text, history, decisions, signal)).replyText;
  }

  async runResult(
    ownerId: string,
    conversation: string,
    eventId: string,
    text: string,
    history: LlmMessage[],
    decisions: RecommendationDecisions,
    signal?: AbortSignal,
    locale: Locale = this.locale
  ): Promise<RecommendationResult> {
    const trace = new AiTrace(
      this.diagnostics.logger,
      {
        correlationId: currentAiTrace()?.correlationId ?? randomUUID(),
        ownerId,
        eventId,
      },
      text,
      'recommendation.tool',
      this.diagnostics.verbose
    );
    for (const message of history) trace.sensitive(message.content);
    return withAiTrace(trace, async () => {
      const leaseId = randomUUID();
      let acquired = false;
      let failure: { error: unknown } | undefined;
      let reply: RecommendationResult = { replyText: '' };
      try {
        reply = await aiStep('recommendation.run', async () => {
          await aiStep('recommendation.state.ensure', () => this.store.ensure(ownerId, conversation));
          acquired = await aiStep('recommendation.lease.acquire', () => {
            return this.store.acquire(ownerId, conversation, leaseId);
          });
          if (!acquired) throw new Error('Recommendation conversation is busy');
          const deadline = AbortSignal.timeout(policy.executionTimeoutMs);
          return this.execute(
            ownerId,
            conversation,
            eventId,
            text,
            history,
            decisions,
            leaseId,
            signal ? AbortSignal.any([signal, deadline]) : deadline,
            locale
          );
        });
      } catch (error) {
        failure = { error };
        trace.fail(error);
      }
      if (acquired) {
        try {
          await aiStep('recommendation.lease.release', () => this.store.release(ownerId, conversation, leaseId));
        } catch (error) {
          trace.fail(error, { stage: 'recommendation.lease.release' });
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
      trace.event('recommendation.completed', { outcome: 'success' });
      return reply;
    });
  }

  private async execute(
    ownerId: string,
    conversation: string,
    eventId: string,
    text: string,
    history: LlmMessage[],
    decisions: RecommendationDecisions,
    leaseId: string,
    signal: AbortSignal,
    locale: Locale
  ): Promise<RecommendationResult> {
    signal.throwIfAborted();
    const interactionAt = new Date();
    const row = await aiStep('recommendation.state.read', () => {
      return this.store.read(ownerId, conversation);
    });
    const messages = recommendationMessages(locale);
    const state = row?.state ?? emptyRecommendationState();
    if (state.events[eventId]) {
      currentAiTrace()?.event('recommendation.replay', { outcome: 'reused' });
      return {
        replyText: state.events[eventId],
        ...(state.eventMovies?.[eventId] ? { movies: state.eventMovies[eventId] } : {}),
      };
    }
    if (!isRecommendationActive(state, interactionAt.getTime())) {
      if (state.active) currentAiTrace()?.event('recommendation.session.expired', { outcome: 'reset' });
      state.active = false;
      state.questions = 0;
      state.history = [];
    }
    const profile = await aiStep('recommendation.profile.read', () => this.profiles.read(ownerId));
    currentAiTrace()?.sensitive(profileText(profile));
    const combined = state.active
      ? [...state.history, { role: 'user' as const, content: text }]
      : [...history.slice(-policy.initialHistoryMessages), { role: 'user' as const, content: text }];
    const plan = await aiStep('recommendation.plan', () => {
      return decisions.plan(
        profile,
        state.active ? state.questions : 0,
        combined.slice(-policy.historyMessages),
        signal,
        locale
      );
    });
    currentAiTrace()?.event('recommendation.plan.selected', {
      recommendNow: plan.recommendNow,
      hasQuestion: Boolean(plan.question),
      restrictionCount: plan.unverifiableRestrictions.length,
      requestedCount: plan.requestedCount,
      softPreferenceCount: plan.softPreferences.length,
    });
    signal.throwIfAborted();
    await aiStep('recommendation.plan.validate', async () => {
      if ([...plan.genres, ...plan.excludeGenres].some((id) => !RECOMMENDATION_GENRE_IDS.includes(id)))
        throw new Error('Unknown genre filter');
    });
    let reply: string;
    let movies: RecommendationMovie[] | undefined;
    if (
      plan.question
      && !plan.recommendNow
      && (state.active ? state.questions : 0) < policy.maxClarificationQuestions
    ) {
      state.questions = (state.active ? state.questions : 0) + 1;
      state.active = true;
      reply = plan.question;
      state.history = [...combined, { role: 'assistant' as const, content: reply }].slice(-policy.historyMessages);
    } else if (plan.unverifiableRestrictions.length) {
      reply = messages.unverifiableRestrictions(plan.unverifiableRestrictions);
      state.active = false;
      state.questions = 0;
      state.history = [];
    } else {
      const filters = {
        genres: plan.genres.filter((id) => {
          return RECOMMENDATION_GENRE_IDS.includes(id);
        }),
        excludeGenres: plan.excludeGenres.filter((id) => {
          return RECOMMENDATION_GENRE_IDS.includes(id);
        }),
        maxRuntime: plan.maxRuntime,
        language: plan.language,
      };
      let candidates: MovieRecord[] = [];
      if (plan.referenceTitle) {
        const search = await aiStep('recommendation.reference.search', () => {
          return this.provider.search(plan.referenceTitle!, 1, locale, {
            actorType: 'user',
            ownerId,
            trigger: 'api_request',
          }
          );
        });
        if (search.movies[0])
          candidates.push(
            ...(await aiStep('recommendation.reference.related', () => {
              return this.provider.related(search.movies[0]!.tmdbId, locale, ownerId);
            }))
          );
      } else {
        const liked = await aiStep('recommendation.seeds.read', () => {
          return this.statuses.list(ownerId, 'liked', 1, policy.likedSeedMovies);
        });
        for (const movie of liked.items) {
          signal.throwIfAborted();
          candidates.push(
            ...(await aiStep(
              'recommendation.seed.related',
              () => {
                return this.provider.related(movie.tmdbId, locale, ownerId);
              },
              { tmdbId: movie.tmdbId }
            ))
          );
        }
      }
      for (let page = 1; page <= policy.discoveryPages; page++) {
        candidates.push(
          ...(await aiStep(
            'recommendation.discover',
            () => {
              return this.provider.discover(filters, page, locale, ownerId);
            },
            { page }
          ))
        );
      }
      candidates = [...new Map(candidates.map((movie) => [movie.tmdbId, movie])).values()];
      const states = await aiStep('recommendation.statuses.read', () => {
        return this.statuses.readForMovies(
          ownerId,
          candidates.map((movie) => movie.tmdbId)
        );
      });
      const excluded = new Set(
        states
          .filter((item) => {
            return item.status === 'watched' || item.preference === 'disliked';
          })
          .map((item) => {
            return item.tmdbId;
          })
      );
      const recent = new Set(
        state.batches.slice(-policy.recentBatches).flatMap((batch) => {
          return batch.movieIds;
        })
      );
      candidates = candidates.filter((movie) => {
        return (
          !excluded.has(movie.tmdbId)
          && !recent.has(movie.tmdbId)
          && (!movie.releaseDate || movie.releaseDate <= new Date().toISOString().slice(0, 10))
          && filters.genres.every((id) => movie.genreIds.includes(id))
          && !filters.excludeGenres.some((id) => movie.genreIds.includes(id))
        );
      });
      const details: MovieDetailRecord[] = [];
      for (const movie of candidates.slice(0, policy.detailCandidates)) {
        signal.throwIfAborted();
        const detail = await aiStep(
          'recommendation.details.fetch',
          () => {
            return this.provider.fetchDetails(movie.tmdbId, locale, {
              actorType: 'user',
              ownerId,
              trigger: 'api_request',
            }
            );
          },
          { tmdbId: movie.tmdbId }
        );
        if (filters.maxRuntime && (!detail.runtimeMinutes || detail.runtimeMinutes > filters.maxRuntime)) continue;
        if (filters.language && detail.originalLanguage !== filters.language) continue;
        await aiStep(
          'recommendation.details.persist',
          () => {
            return this.catalog.writeMovieDetail(detail, new Date(), locale);
          },
          { tmdbId: movie.tmdbId }
        );
        details.push(detail);
      }
      if (!details.length) reply = messages.noCandidates;
      else {
        const ranked = await aiStep(
          'recommendation.rank',
          () => {
            return decisions.rank(profile, combined.slice(-policy.historyMessages), details, signal, locale, plan);
          },
          { candidateCount: details.length, requestedCount: plan.requestedCount }
        );
        const chosen = [...new Map(ranked.movies.map((item) => [item.tmdbId, item])).values()];
        await aiStep('recommendation.rank.validate', async () => {
          if (chosen.some((item) => !details.some((movie) => movie.tmdbId === item.tmdbId)))
            throw new Error('Unknown recommendation candidate');
        });
        // Recheck mutable user state immediately before delivering the batch.
        const latest = await aiStep('recommendation.statuses.recheck', () => {
          return this.statuses.readForMovies(
            ownerId,
            chosen.map((item) => item.tmdbId)
          );
        });
        const blocked = new Set(
          latest
            .filter((item) => {
              return item.status === 'watched' || item.preference === 'disliked';
            })
            .map((item) => {
              return item.tmdbId;
            })
        );
        const eligible = chosen
          .filter((item) => {
            return !blocked.has(item.tmdbId);
          })
          .slice(0, plan.requestedCount);
        currentAiTrace()?.event('recommendation.selection.completed', {
          requestedCount: plan.requestedCount,
          selectedCount: eligible.length,
          outcome: eligible.length < plan.requestedCount ? 'shortfall' : 'complete',
        });
        movies = eligible.map((item) => {
          const detail = details.find((movie) => movie.tmdbId === item.tmdbId)!;
          return {
            tmdbId: item.tmdbId,
            title: detail.title,
            reason: item.reason,
            ...(detail.posterPath ? { posterPath: detail.posterPath } : {}),
          };
        });
        reply
          = eligible
            .map((item, index) => {
              return `${index + 1}. ${
                details.find((movie) => movie.tmdbId === item.tmdbId)!.title
              }\n${item.reason}\nhttps://www.themoviedb.org/movie/${item.tmdbId}`;
            })
            .join('\n\n') || messages.insufficientEvidence;
        state.batches = [
          ...state.batches,
          {
            id: randomUUID(),
            movieIds: eligible.map((item) => {
              return item.tmdbId;
            }),
            profileVersion: profile.version,
            at: new Date().toISOString(),
          },
        ].slice(-policy.retainedBatches);
      }
      state.active = false;
      state.questions = 0;
      state.history = [];
    }
    state.events = Object.fromEntries(
      [...Object.entries(state.events), [eventId, reply]].slice(-policy.retainedEvents)
    );
    state.eventMovies = Object.fromEntries(
      Object.keys(state.events).flatMap((id) => {
        const savedMovies = id === eventId ? movies : state.eventMovies?.[id];
        return savedMovies?.length ? [[id, savedMovies]] : [];
      })
    );
    signal.throwIfAborted();
    currentAiTrace()?.sensitive(reply);
    state.lastInteractionAt = interactionAt.toISOString();
    await aiStep('recommendation.state.save', async () => {
      if (!(await this.store.save(ownerId, conversation, leaseId, state))) throw new Error('Recommendation lease lost');
    });
    return { replyText: reply, ...(movies?.length ? { movies } : {}) };
  }
}
