import type { Locale } from '@movie-hub/contract';
import type { LlmMessage } from '../llm/llm.types.js';

/** Provider IDs are registry keys, never URLs or credentials supplied by a model. */
export interface ResourceRelease {
  provider: string;
  id: string;
  title: string;
  sizeBytes?: number;
  resolution?: string;
  seeders?: number;
  releaseGroup?: string;
}
export interface ResourceSourceResult {
  provider: string;
  status: 'available' | 'unavailable' | 'unmatchable' | 'not_configured' | 'error';
  releases: ResourceRelease[];
  queriedAt?: string;
  cached?: boolean;
  errorCode?: string;
}
export interface ResourceProvider {
  id: string;
  name: string;
  query(ownerId: string, tmdbId: number, signal: AbortSignal, options?: { refresh: boolean }): Promise<ResourceSourceResult>;
}
export interface ResourceMovie {
  tmdbId: number;
  title: string;
  originalTitle?: string;
  year?: number;
}
export interface ResourcePlan {
  title: string | null;
  year: number | null;
  /** Only IDs from the supplied server candidates may be selected. */
  candidateId: number | null;
  resolution: '2160p' | '1080p' | '720p' | 'any' | null;
  /** null retains the previous filter; [] means all registered sources. */
  providers: string[] | null;
  releaseIndex: number | null;
  page: number | 'next' | 'previous' | null;
  refresh: boolean;
  question: string | null;
  unsupported: string[];
}
export interface ResourceQueryState {
  updatedAt: string;
  candidates: ResourceMovie[];
  movie: ResourceMovie | null;
  resolution: ResourcePlan['resolution'];
  providers: string[];
  /** Full sorted filtered result, with stable one-based numbers across pages. */
  releases: ResourceRelease[];
  /** Optional for compatibility with conversations saved before pagination was introduced. */
  snapshot?: { createdAt: string; results: ResourceSourceResult[] };
  page?: number;
  events: Array<{ id: string; replyText: string }>;
}
export interface ResourceQueryStore {
  ensure(ownerId: string, conversation: string): Promise<void>;
  read(ownerId: string, conversation: string): Promise<ResourceQueryState | null>;
  acquire(ownerId: string, conversation: string, leaseId: string): Promise<boolean>;
  save(ownerId: string, conversation: string, leaseId: string, state: ResourceQueryState): Promise<boolean>;
  release(ownerId: string, conversation: string, leaseId: string): Promise<void>;
}
export interface ResourceDecisions {
  plan(
    text: string,
    history: LlmMessage[],
    context: Pick<ResourceQueryState, 'candidates' | 'movie' | 'resolution' | 'providers'> & {
      sources: Array<{ id: string; name: string }>;
      releaseCount: number;
      page: number;
      pageCount: number;
    },
    locale: Locale,
    signal: AbortSignal,
  ): Promise<ResourcePlan>;
}
export interface ResourceQueryCapability {
  /** Owner/conversation-scoped context. Expired interactive snapshots must not be selected. */
  context?(ownerId: string, conversation: string): Promise<ResourceQueryState | null>;
  active(ownerId: string, conversation: string): Promise<boolean>;
  run(
    ownerId: string,
    conversation: string,
    eventId: string,
    text: string,
    history: LlmMessage[],
    decisions: ResourceDecisions,
    signal?: AbortSignal,
    locale?: Locale,
  ): Promise<{ replyText: string }>;
}
