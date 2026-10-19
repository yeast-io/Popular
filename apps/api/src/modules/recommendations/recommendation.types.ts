import type { Locale, TasteProfile } from '@movie-hub/contract';
import type { LlmMessage } from '../llm/llm.types.js';
import type { MovieDetailRecord, MovieRecord, MovieSearchProvider } from '../movies/movie.types.js';

export interface RecommendationFilters {
  genres: number[];
  excludeGenres: number[];
  maxRuntime: number | null;
  language: string | null;
}

export interface RecommendationPlan extends RecommendationFilters {
  recommendNow: boolean;
  requestedCount: number;
  /** Subjective tastes influence ranking and never block retrieval by themselves. */
  softPreferences: string[];
  question: string | null;
  referenceTitle: string | null;
  unverifiableRestrictions: string[];
}

export interface RankedMovie {
  tmdbId: number;
  reason: string;
}

export interface RecommendationMovie {
  tmdbId: number;
  title: string;
  reason: string;
  posterPath?: string;
}

export interface RecommendationResult {
  replyText: string;
  movies?: RecommendationMovie[];
}

export interface RecommendationState {
  questions: number;
  active: boolean;
  /** ISO time of the last successfully processed new interaction; absent on legacy records. */
  lastInteractionAt?: string | null;
  history: LlmMessage[];
  events: Record<string, string>;
  eventMovies?: Record<string, RecommendationMovie[]>;
  batches: Array<{ id: string; movieIds: number[]; profileVersion: number; at: string }>;
}

export interface RecommendationStore {
  ensure(ownerId: string, conversation: string): Promise<void>;
  read(ownerId: string, conversation: string): Promise<{ state: RecommendationState; updatedAt: Date } | null>;
  acquire(ownerId: string, conversation: string, leaseId: string): Promise<boolean>;
  save(ownerId: string, conversation: string, leaseId: string, state: RecommendationState): Promise<boolean>;
  release(ownerId: string, conversation: string, leaseId: string): Promise<void>;
}

export interface RecommendationProfileReader {
  read(ownerId: string): Promise<TasteProfile>;
}

export interface DiscoveryProvider extends MovieSearchProvider {
  discover(filters: RecommendationFilters, page: number, locale: Locale, ownerId: string): Promise<MovieRecord[]>;
  related(tmdbId: number, locale: Locale, ownerId: string): Promise<MovieRecord[]>;
}

/** Model decisions are supplied by the calling AssistantAgent; the tool owns no model client. */
export interface RecommendationDecisions {
  plan(
    profile: TasteProfile,
    questions: number,
    conversation: LlmMessage[],
    signal: AbortSignal,
    locale: Locale,
  ): Promise<RecommendationPlan>;
  rank(
    profile: TasteProfile,
    conversation: LlmMessage[],
    candidates: MovieDetailRecord[],
    signal: AbortSignal,
    locale: Locale,
    selection: Pick<RecommendationPlan, 'requestedCount' | 'softPreferences'>,
  ): Promise<{ movies: RankedMovie[] }>;
}

export interface RecommendationCapability {
  active(ownerId: string, conversation: string): Promise<boolean>;
  runResult(
    ownerId: string,
    conversation: string,
    eventId: string,
    text: string,
    history: LlmMessage[],
    decisions: RecommendationDecisions,
    signal?: AbortSignal,
  ): Promise<RecommendationResult>;
}
