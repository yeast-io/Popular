export interface MovieReleaseCacheIdentity {
  ownerId: string;
  tmdbId: number;
  site: string;
  page: number;
  locale: string;
  credentialVersion: string;
  imdbId?: string;
}

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
  identity: MovieReleaseCacheIdentity;
  force?: boolean;
  validate(value: unknown): value is T;
  fetch(): Promise<T>;
}
