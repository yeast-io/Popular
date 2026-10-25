export interface MovieReleaseCacheIdentity {
  ownerId: string;
  tmdbId: number;
  site: string;
  page: number;
  locale: string;
  credentialVersion: string;
  imdbId?: string;
}

export interface ResourceQueryCacheIdentity extends Omit<MovieReleaseCacheIdentity, 'tmdbId' | 'imdbId'> {
  query: string;
  mediaType: 'tv';
  tmdbId?: never;
  imdbId?: never;
}

export type ReleaseCacheIdentity = MovieReleaseCacheIdentity | ResourceQueryCacheIdentity;

export interface MovieReleaseCacheEntry {
  value: unknown;
  expiresAt: string;
}

export interface MovieReleaseCacheStore {
  read(key: string): Promise<MovieReleaseCacheEntry | null>;
  write(key: string, value: unknown, ttlMs: number): Promise<string>;
  readRevision(scopeKey: string): Promise<string | null>;
  activateRevision(scopeKey: string, revision: string, ttlMs: number): Promise<void>;
}

export interface MovieReleaseCacheQuery<T extends { cached: boolean; cacheExpiresAt?: string }> {
  identity: ReleaseCacheIdentity;
  force?: boolean;
  validate(value: unknown): value is T;
  fetch(): Promise<T>;
}

export interface ResourceRefreshStore {
  claim(ownerId: string, site: string, intervalMs: number): Promise<number>;
}
