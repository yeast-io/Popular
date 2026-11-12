import type { ResourceSiteRelease } from '@movie-hub/contract';
import type { z } from 'zod';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';
import { releaseTitleMetadata } from '../../modules/resource-sites/release-metadata.domain.js';
import { releaseTags } from '../../modules/resource-sites/release-tags.domain.js';
import { hdareaEnvelopeSchema } from './hdarea.schema.js';
import type { hdareaReleaseSchema } from './hdarea.schema.js';

export function apiData(bytes: Uint8Array): unknown {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (cause) {
    throw new ResourceSiteError('invalidResponse', { cause });
  }
  const parsed = hdareaEnvelopeSchema.safeParse(json);
  if (!parsed.success) throw new ResourceSiteError('invalidResponse', { cause: parsed.error });
  if (!parsed.data.success || String(parsed.data.code) !== '0')
    throw new ResourceSiteError(
      ['401', '403'].includes(String(parsed.data.code))
        ? 'authentication'
        : String(parsed.data.code) === '429'
          ? 'rateLimited'
          : 'invalidResponse'
    );
  return parsed.data.data;
}

export function apiRelease(row: z.infer<typeof hdareaReleaseSchema>, baseUrl: string): ResourceSiteRelease {
  const metadata = releaseTitleMetadata(row.name);
  const tags = releaseTags(
    row.name,
    row.small_descr ?? '',
    ...(row.tags ?? []).map((tag) => (typeof tag === 'string' ? tag : tag.name))
  );
  const publishedAt = row.added_ts ? new Date(row.added_ts * 1000) : undefined;
  return {
    id: row.id,
    title: row.name,
    detailsUrl: new URL(`details.php?id=${row.id}`, baseUrl).href,
    ...(row.small_descr ? { description: row.small_descr } : {}),
    ...(row.size != null ? { sizeBytes: row.size } : {}),
    ...(row.seeders != null ? { seeders: row.seeders } : {}),
    ...(/^tt\d+$/.test(row.imdb_id ?? '') ? { imdbId: row.imdb_id! } : {}),
    ...(publishedAt && Number.isFinite(publishedAt.getTime()) ? { publishedAt: publishedAt.toISOString() } : {}),
    ...(row.medium_name ? { medium: row.medium_name } : {}),
    ...(row.codec_name ? { videoCodec: row.codec_name } : {}),
    ...(row.audiocodec_name ? { audioCodec: row.audiocodec_name } : {}),
    ...(row.standard_name ? { resolution: row.standard_name === '4K' ? '2160p' : row.standard_name } : {}),
    ...(row.team_name && row.team_name.toLowerCase() !== 'other' ? { releaseGroup: row.team_name } : {}),
    ...metadata,
    ...(tags.length ? { tags } : {}),
  };
}
