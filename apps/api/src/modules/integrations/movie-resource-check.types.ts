import type { IntegrationFailureType, MovieRelease } from '@movie-hub/contract';
import type { ExternalRequestContext } from '../external-usage/external-usage.types.js';

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
  checking: boolean;
  availability: MovieResourceAvailability;
  matchedBy?: MovieResourceMatchMethod;
  checkedAt?: Date;
  expiresAt?: Date;
  lastAttemptAt?: Date;
  lastAttemptStatus?: 'success' | 'error';
  lastErrorCode?: MovieResourceCheckErrorCode;
  identityFingerprint?: string;
}

type SuccessfulMovieResourceCheck = ({
  lastAttemptStatus: 'success';
  checkedAt: Date;
  expiresAt: Date;
  availability: 'available' | 'unavailable';
  matchedBy: MovieResourceMatchMethod;
} | {
  lastAttemptStatus: 'success';
  checkedAt: Date;
  availability: 'unmatchable';
  identityFingerprint: string;
});

export type MovieResourceCheckCompletion = SuccessfulMovieResourceCheck | {
  lastAttemptStatus: 'error';
  lastErrorCode: MovieResourceCheckErrorCode;
};

export interface MovieResourceCheckStore {
  readForMovies(ownerId: string, tmdbIds: number[]): Promise<MovieResourceCheckRecord[]>;
  readOne(key: MovieResourceCheckKey): Promise<MovieResourceCheckRecord | null>;
  tryAcquire(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    leaseExpiresAt: Date,
    failedAttemptBefore: Date,
    identityFingerprint: string | undefined,
    credentialsVerifiedAt: Date | undefined,
    force: boolean,
  ): Promise<boolean>;
  complete(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    result: MovieResourceCheckCompletion,
  ): Promise<void>;
  recordAttempt(
    key: MovieResourceCheckKey,
    attemptedAt: Date,
    result: MovieResourceCheckCompletion,
  ): Promise<void>;
}

export interface MTeamRelease {
  id?: string;
  title?: string;
  imdbId?: string;
  visible: boolean;
  banned: boolean;
  seeders: number;
  leechers?: number;
  sizeBytes?: number;
  publishedAt?: string;
  discount?: string;
  resolution?: string;
  medium?: string;
  videoCodec?: string;
  audioCodec?: string;
  tags?: string[];
}

export type ActiveMovieRelease = MovieRelease;

export interface MTeamResourceSearcher {
  searchMovies(
    baseUrl: string,
    apiKey: string,
    query: { imdbId: string } | { title: string },
    context?: ExternalRequestContext,
  ): Promise<MTeamRelease[]>;
}

export interface MTeamTorrentDownloader {
  downloadTorrent(baseUrl: string, apiKey: string, releaseId: string, context?: ExternalRequestContext): Promise<Uint8Array>;
}
