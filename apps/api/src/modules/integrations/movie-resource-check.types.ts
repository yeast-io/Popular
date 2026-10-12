import type { IntegrationFailureType } from '@movie-hub/contract';

export type MovieResourceProvider = 'mteam';
export type MovieResourceAvailability = 'available' | 'unavailable' | 'unchecked' | 'unmatchable';
export type MovieResourceMatchMethod = 'imdb';
export type MovieResourceCheckErrorCode = IntegrationFailureType | 'permission' | 'rate_limited' | 'internal_error';

export interface MovieResourceCheckKey {
  ownerId: string;
  tmdbId: number;
  provider: MovieResourceProvider;
}

export interface MovieResourceCheckRecord extends MovieResourceCheckKey {
  availability: MovieResourceAvailability;
  matchedBy?: MovieResourceMatchMethod;
  checkedAt?: Date;
  expiresAt?: Date;
  lastAttemptAt?: Date;
  lastAttemptStatus?: 'success' | 'error';
  lastErrorCode?: MovieResourceCheckErrorCode;
}

type SuccessfulMovieResourceCheck = {
  lastAttemptStatus: 'success';
  checkedAt: Date;
  expiresAt: Date;
} & ({
  availability: 'available' | 'unavailable';
  matchedBy: MovieResourceMatchMethod;
} | {
  availability: 'unmatchable';
});

export type MovieResourceCheckCompletion = SuccessfulMovieResourceCheck | {
  lastAttemptStatus: 'error';
  lastErrorCode: MovieResourceCheckErrorCode;
};

export interface MovieResourceCheckStore {
  readForMovies(ownerId: string, tmdbIds: number[]): Promise<MovieResourceCheckRecord[]>;
  tryAcquire(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    leaseExpiresAt: Date,
    failedAttemptBefore: Date,
    force: boolean,
  ): Promise<boolean>;
  complete(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    result: MovieResourceCheckCompletion,
  ): Promise<void>;
}

export interface MTeamRelease {
  imdbId?: string;
  visible: boolean;
  banned: boolean;
  seeders: number;
}

export interface MTeamResourceSearcher {
  searchMovies(
    baseUrl: string,
    apiKey: string,
    query: { imdbId: string } | { title: string },
  ): Promise<MTeamRelease[]>;
}
