import type { MovieResourceSyncBatch, MovieResourceSyncStatus } from '@movie-hub/contract';

export interface StoredMovieResourceSyncBatch extends MovieResourceSyncBatch {
  ownerId: string;
  movieIds: number[];
  cursor: number;
  force: boolean;
  rateLimitRetries: number;
}

export type SyncCounter = 'available' | 'unavailable' | 'unmatchable' | 'failed';

export interface MovieResourceSyncBatchStore {
  createOrGetActive(ownerId: string, movieIds: number[], force: boolean, now: Date): Promise<StoredMovieResourceSyncBatch>;
  readCurrent(ownerId: string): Promise<StoredMovieResourceSyncBatch | null>;
  read(ownerId: string, id: string): Promise<StoredMovieResourceSyncBatch | null>;
  readRecoverable(): Promise<StoredMovieResourceSyncBatch[]>;
  setRunning(id: string): Promise<void>;
  advance(id: string, counter: SyncCounter): Promise<void>;
  pause(id: string, resumeAt: Date): Promise<void>;
  finish(id: string, status: Extract<MovieResourceSyncStatus, 'completed' | 'failed'>, needsAction?: 'update_api_key'): Promise<void>;
}
