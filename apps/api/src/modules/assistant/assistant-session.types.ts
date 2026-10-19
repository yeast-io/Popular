import type { DownloadProvider, Locale } from '@movie-hub/contract';

export interface AssistantSession {
  updatedAt: string;
  locale?: Locale;
  stage: 'idle' | 'await_movie' | 'await_resource' | 'await_provider' | 'submitting';
  selection?: { tmdbId: number; source: string; releaseId: string; title: string; selectedAt: string };
  providers?: DownloadProvider[];
  provider?: DownloadProvider;
  submissionEventId?: string;
  events: Array<{ id: string; replyText: string; intent: 'download' }>;
}
export interface AssistantSessionStore {
  ensure(ownerId: string, conversation: string): Promise<void>;
  read(ownerId: string, conversation: string): Promise<AssistantSession | null>;
  acquire(ownerId: string, conversation: string, leaseId: string): Promise<boolean>;
  save(ownerId: string, conversation: string, leaseId: string, state: AssistantSession): Promise<boolean>;
  release(ownerId: string, conversation: string, leaseId: string): Promise<void>;
}

/** Snapshot metadata for model decisions; IDs and release payloads stay server-side. */
export interface AssistantDownloadContext {
  stage: AssistantSession['stage'];
  providers: DownloadProvider[];
  hasSelection: boolean;
  resources: { hasSnapshot: boolean; releaseCount: number; page: number; pageCount: number };
}
