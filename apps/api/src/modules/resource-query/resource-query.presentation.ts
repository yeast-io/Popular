import type { ResourceRelease } from './resource-query.types.js';

export const RESOURCE_PAGE_SIZE = 10;

/** Use explicit provider metadata first; a release title is only a fallback. */
export function releaseResolution(release: ResourceRelease): string | undefined {
  return parseResolution(release.resolution ?? '') ?? parseResolution(release.title);
}
function parseResolution(value: string): string | undefined {
  if (/\b(?:2160[pi]?|4k|uhd)\b/i.test(value)) return '4K';
  if (/\b(?:4320[pi]?|8k)\b/i.test(value)) return '8K';
  return value.match(/\b(1080[pi]|720p|576[pi]|480[pi])\b/i)?.[1]?.toLowerCase();
}

/** Conservative scene-name parsing. Uncertain suffixes remain unknown, never model-invented. */
export function releaseGroup(release: ResourceRelease): string | undefined {
  if (release.releaseGroup) return release.releaseGroup;
  const title = release.title.trim().replace(/\.(?:mkv|mp4|avi|m2ts|ts|torrent)$/i, '');
  if (!/\b(?:\d{3,4}[pi]|4k|8k|uhd|bluray|blu-ray|web[ ._-]?dl|x26[45]|h[ .]?26[45]|hevc)\b/i.test(title))
    return undefined;
  const atGroup = title.match(/@([a-z\d][a-z\d._-]{1,39})$/i)?.[1];
  if (atGroup) return atGroup;
  // This known compound group must not be reduced to its final hyphen component.
  if (/(?:^|[\s.-])MNHD-FRDS$/i.test(title)) return 'MNHD-FRDS';
  const group = title.match(/-([a-z\d][a-z\d._]{1,31})$/i)?.[1];
  if (!group || /^(?:dl|rip|ray|hdr\d*|sdr|hevc|avc|x26[45]|h26[45]|aac|dts|atmos|truehd|remux|proper|repack|extended)$/i.test(group))
    return undefined;
  return group;
}

export function compareReleases(left: ResourceRelease, right: ResourceRelease): number {
  const seeders = (release: ResourceRelease) => {
    return release.seeders !== undefined && Number.isFinite(
      release.seeders
    ) && release.seeders >= 0 ? release.seeders : -1;
  };
  const difference = seeders(right) - seeders(left);
  if (difference) return difference;
  return compareText(left.provider, right.provider) || compareText(left.id, right.id);
}
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function matchesResolution(release: ResourceRelease, resolution: string | null): boolean {
  if (!resolution || resolution === 'any') return true;
  return releaseResolution(release) === (resolution === '2160p' ? '4K' : resolution);
}

/** Single-line fields cannot smuggle extra numbered rows into a chat message. */
export function compactField(value: string, maxLength: number): string {
  const clean = [...value].map((character) => {
    return character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  let shortened = clean.slice(0, maxLength - 1);
  if (/[\uD800-\uDBFF]$/.test(shortened)) shortened = shortened.slice(0, -1);
  return shortened + '…';
}

/** Brackets separate the resource number from numeric resolutions in plain-text chat clients. */
export function releaseNumberLabel(index: number): string {
  return `【${index}】`;
}
