import type { Locale, TasteProfile } from '@movie-hub/contract';
import type { LlmMessage } from '../llm/llm.types.js';
import type { MovieRecord, MovieSearchProvider } from '../movies/movie.types.js';

export interface RecommendationFilters {
  genres: number[];
  excludeGenres: number[];
  maxRuntime: number | null;
  language: string | null;
}

export interface RecommendationPlan extends RecommendationFilters {
  question: string | null;
  referenceTitle: string | null;
  unverifiableRestrictions: string[];
}

export interface RankedMovie {
  tmdbId: number;
  reason: string;
}

export interface RecommendationState {
  questions: number;
  active: boolean;
  history: LlmMessage[];
  events: Record<string, string>;
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
