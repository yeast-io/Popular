import type { ResourceSiteRelease } from '@movie-hub/contract';

function normalizeTag(value: string): string {
  const tag = value.trim();
  if (/^(?:4k|2160p|2160)$/i.test(tag)) return '4K';
  if (/^(?:8k|4320p|4320)$/i.test(tag)) return '8K';
  if (/^(?:中字|中文字幕|中英字幕|简繁字幕|chinese[- ]subtitles)$/i.test(tag)) return 'chinese-subtitles';
  if (/^(?:dovi|dv|dolby[ ._-]*vision)$/i.test(tag)) return 'DoVi';
  if (/^hdr10\+$/i.test(tag)) return 'HDR10+';
  if (/^hdr10$/i.test(tag)) return 'HDR10';
  if (/^hdr$/i.test(tag)) return 'HDR';
  return tag;
}

export function resourceReleaseTags(release: ResourceSiteRelease): string[] {
  const tags = [release.resolution, release.medium, release.videoCodec, release.audioCodec,
    release.releaseGroup, ...(release.tags ?? [])].filter((value): value is string => Boolean(value));
  const text = `${release.title} ${release.description ?? ''}`;
  if (!release.resolution) {
    const resolution = release.title.match(/\b(?:4320p|8k|2160p|4k|1080[pi]|720p|480p)\b/i)?.[0];
    if (resolution) tags.unshift(resolution);
  }
  if (/\b(?:DoVi|DV|Dolby[ ._-]*Vision)\b/i.test(text)) tags.push('DoVi');
  if (/\bHDR10\+/i.test(text)) tags.push('HDR10+');
  else if (/\bHDR10\b/i.test(text)) tags.push('HDR10');
  else if (/\bHDR\b/i.test(text)) tags.push('HDR');
  if (/(?:中字|中文字幕|中英字幕|简繁字幕)/.test(text)) tags.push('chinese-subtitles');
  return [...new Map(tags.map((tag) => {
    const normalized = normalizeTag(tag);
    return [normalized.toLowerCase(), normalized] as const;
  }).filter(([, value]) => value)).values()];
}
