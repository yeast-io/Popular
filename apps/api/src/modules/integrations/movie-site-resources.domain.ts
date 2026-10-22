import type { MovieResourceCheckResponse } from '@movie-hub/contract';
import type { MovieResourceCheckCompletion, MovieResourceCheckRecord } from './movie-resource-check.types.js';

export function siteCheckResponse(site: string, row?: MovieResourceCheckRecord | null): MovieResourceCheckResponse {
  return {
    provider: site,
    availability: row?.availability ?? 'unchecked',
    checking: row?.checking ?? false,
    ...(row?.checkedAt ? { checkedAt: row.checkedAt.toISOString() } : {}),
    ...(row?.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(row?.lastAttemptAt ? { lastAttemptAt: row.lastAttemptAt.toISOString() } : {}),
    ...(row?.lastAttemptStatus ? { lastAttemptStatus: row.lastAttemptStatus } : {}),
    ...(row?.lastErrorCode
      ? {
          lastErrorCode:
            site === 'mteam'
              ? row.lastErrorCode === 'authentication'
                ? ('MTEAM_AUTH_FAILED' as const)
                : ('MTEAM_UNEXPECTED_RESPONSE' as const)
              : row.lastErrorCode === 'authentication'
                ? ('RESOURCE_SITE_NOT_CONFIGURED' as const)
                : ('RESOURCE_SITE_FAILED' as const),
        }
      : {}),
  };
}
export function aggregateSiteChecks(
  sources: MovieResourceCheckResponse[],
  now = Date.now()
): MovieResourceCheckResponse {
  const fresh = sources.filter((source) => {
    return (
      source.lastAttemptStatus === 'success'
      && !source.checking
      && (!source.expiresAt || new Date(source.expiresAt).getTime() > now)
    );
  });
  const incomplete
    = !sources.length
      || fresh.length !== sources.length
      || fresh.some((source) => {
        return source.availability === 'unchecked';
      });
  const availability = fresh.some((source) => source.availability === 'available')
    ? 'available'
    : incomplete
      ? 'unchecked'
      : fresh.every((source) => source.availability === 'unavailable')
        ? 'unavailable'
        : fresh.some((source) => source.availability === 'unmatchable')
          ? 'unmatchable'
          : 'unchecked';
  const times = fresh.flatMap((source) => (source.checkedAt ? [source.checkedAt] : [])).sort();
  return {
    provider: 'all',
    sources,
    availability,
    checking: sources.some((source) => source.checking),
    incomplete,
    ...(times.length === sources.length && times[0] ? { checkedAt: times[0] } : {}),
    ...(sources.some((source) => source.lastAttemptStatus === 'error')
      ? { lastAttemptStatus: 'error' as const }
      : !incomplete
          ? { lastAttemptStatus: 'success' as const }
          : {}),
  };
}
export function completionForSiteCheck(row: MovieResourceCheckRecord | null): MovieResourceCheckCompletion {
  if (!row || row.checking || !row.checkedAt || row.availability === 'unchecked')
    return { lastAttemptStatus: 'error', lastErrorCode: row?.lastErrorCode ?? 'internal_error' };
  if (row.lastAttemptStatus === 'error')
    return { lastAttemptStatus: 'error', lastErrorCode: row.lastErrorCode ?? 'internal_error' };
  if (row.availability === 'unmatchable')
    return {
      lastAttemptStatus: 'success',
      availability: 'unmatchable',
      checkedAt: row.checkedAt,
      identityFingerprint: row.identityFingerprint ?? '',
    };
  return {
    lastAttemptStatus: 'success',
    availability: row.availability,
    checkedAt: row.checkedAt,
    expiresAt: row.expiresAt ?? row.checkedAt,
    matchedBy: 'imdb',
  };
}
