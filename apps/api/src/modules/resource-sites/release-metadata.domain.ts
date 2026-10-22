import type { ResourceSiteRelease } from '@movie-hub/contract';

/** Recognize semantic markers regardless of their order in a release title. */
export function releaseTitleMetadata(
  title: string
): Pick<ResourceSiteRelease, 'resolution' | 'medium' | 'videoCodec' | 'audioCodec' | 'releaseGroup'> {
  const metadata: ReturnType<typeof releaseTitleMetadata> = {};
  const resolution = title.match(/\b(4320p|2160p|1080[pi]|720p|576[pi]|480[pi])\b/i);
  if (resolution) metadata.resolution = resolution[1]!.toLowerCase();
  const medium = title.match(
    /\b(REMUX|WEB[- .]?DL|WEB[- .]?Rip|Blu[- .]?Ray|BDRip|BRRip|HDTV|DVD[- .]?Rip|DVD)\b/i
  )?.[1];
  if (medium) {
    const key = medium.replace(/[- .]/g, '').toLowerCase();
    const normalizedMedium = (
      {
        remux: 'Remux',
        webdl: 'WEB-DL',
        webrip: 'WEBRip',
        bluray: 'BluRay',
        bdrip: 'BDRip',
        brrip: 'BRRip',
        hdtv: 'HDTV',
        dvdrip: 'DVDRip',
        dvd: 'DVD',
      } as Record<string, string>
    )[key];
    if (normalizedMedium) metadata.medium = normalizedMedium;
    if (/\bREMUX\b/i.test(title)) metadata.medium = 'Remux';
  }
  const video = title.match(/\b(?:[hx][ .-]?26[456]|HEVC|AVC|AV1|VC[- .]?1|MPEG[- .]?2)\b/i)?.[0];
  if (video) {
    const key = video.replace(/[ .-]/g, '').toLowerCase();
    metadata.videoCodec = /^(?:[hx]265|hevc)$/.test(key)
      ? 'H.265'
      : /^(?:[hx]264|avc)$/.test(key)
        ? 'H.264'
        : key === 'h266' || key === 'x266'
          ? 'H.266'
          : key === 'vc1'
            ? 'VC-1'
            : key === 'mpeg2'
              ? 'MPEG-2'
              : 'AV1';
  }
  const audio = title.match(
    /\b(?:DTS[- .]?HD[- .]?MA|DTS[- .]?HD[- .]?HR|DTS[- .]?[Xx]|DTS|TrueHD|DDP|DD\+|E[- .]?AC[- .]?3|AC[- .]?3|DD|AAC|FLAC|LPCM|PCM|MP3)(?=\d|\b|[ ._-])/i
  )?.[0];
  if (audio) {
    const key = audio.replace(/[ .-]/g, '').toLowerCase();
    const codec = (
      {
        'dtshdma': 'DTS-HD MA',
        'dtshdhr': 'DTS-HD HR',
        'dtsx': 'DTS:X',
        'dts': 'DTS',
        'truehd': 'TrueHD',
        'ddp': 'E-AC-3',
        'dd+': 'E-AC-3',
        'eac3': 'E-AC-3',
        'ac3': 'AC-3',
        'dd': 'AC-3',
        'aac': 'AAC',
        'flac': 'FLAC',
        'lpcm': 'LPCM',
        'pcm': 'PCM',
        'mp3': 'MP3',
      } as Record<string, string>
    )[key];
    const channels = title
      .slice(title.indexOf(audio) + audio.length)
      .match(/^[ ._-]*([12567][ .]1|[12]\.0)(?!\d)/)?.[1]
      ?.replace(' ', '.');
    metadata.audioCodec = [codec, channels, /\bAtmos\b/i.test(title) ? 'Atmos' : undefined].filter(Boolean).join(' ');
  }
  // A bare movie-name hyphen is not evidence of a release group. Do not split WEB-DL, DTS-HD, etc.
  if (
    (metadata.resolution || metadata.videoCodec || metadata.medium)
    && !/(?:WEB[- .]?(?:DL|Rip)|Blu[- .]?Ray|DTS[- .]?(?:HD(?:[- .]?MA)?|X)|(?:E[- .]?)?AC[- .]?3|[HX][- .]?26[456]|VC[- .]?1|MPEG[- .]?2)$/i.test(
      title.trim()
    )
  ) {
    const group = title.trim().match(/-([A-Za-z0-9][A-Za-z0-9@._]*)$/)?.[1];
    if (group && /[a-z]/i.test(group)) metadata.releaseGroup = group;
  }
  return metadata;
}
