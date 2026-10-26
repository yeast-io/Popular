import { randomUUID } from 'node:crypto';
import type { ResourceSiteRelease, WatchlistMediaType } from '@movie-hub/contract';
import type { ResourceNotificationEntry } from './resource-notification.types.js';

export function createResourceNotification(
  mediaType: WatchlistMediaType,
  tmdbId: number,
  title: string,
  now: Date,
  correlationId: string = randomUUID()
): ResourceNotificationEntry {
  return {
    id: randomUUID(),
    correlationId,
    attempts: 0,
    mediaType,
    tmdbId,
    title,
    status: 'pending',
    createdAt: now,
    nextRunAt: now,
    lockedUntil: new Date(0),
  };
}

// Conservative initial policy: TV needs an exact normalized title prefix followed by a season/episode marker.
// No fuzzy title matching; detailed release preferences can be added after the matching requirements are settled.
export function matchesTvResource(release: ResourceSiteRelease, names: string[]): boolean {
  if (release.seeders !== undefined && release.seeders <= 0) return false;
  const normalize = (value: string) =>
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const title = normalize(release.title);
  return names.some((name) => {
    const prefix = normalize(name);
    if (!prefix || !title.startsWith(`${prefix} `)) return false;
    const remainder = title.slice(prefix.length).trim();
    return /^(?:(?:19|20)\d{2} )?(?:s\d{1,3}(?:e\d{1,4})?\b|season \d+\b|第[一二三四五六七八九十百\d]+[季集])/u.test(
      remainder
    );
  });
}
