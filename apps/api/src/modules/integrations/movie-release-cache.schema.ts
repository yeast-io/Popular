import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  MovieReleaseListResponseSchema,
  MovieSiteReleaseListSchema,
  type MovieReleaseListResponse,
  type MovieSiteReleaseList,
} from '@movie-hub/contract';

if (!FormatRegistry.Has('date-time'))
  FormatRegistry.Set('date-time', (value) => !Number.isNaN(Date.parse(value)));

export function isMTeamReleaseCacheValue(value: unknown): value is MovieReleaseListResponse {
  return Value.Check(MovieReleaseListResponseSchema, value);
}

export function isSiteReleaseCacheValue(value: unknown): value is MovieSiteReleaseList {
  return Value.Check(MovieSiteReleaseListSchema, value);
}
