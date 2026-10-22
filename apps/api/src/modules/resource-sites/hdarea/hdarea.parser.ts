import { load, type CheerioAPI } from 'cheerio';
import { releaseTags } from '../release-tags.domain.js';
import { releaseTitleMetadata } from '../release-metadata.domain.js';
import type { ResourceSiteRelease } from '@movie-hub/contract';
import { ResourceSiteError } from '../resource-site.errors.js';
import { HDAREA_SELECTORS } from './hdarea.policy.js';

export function authenticatedDocument(bytes: Uint8Array) {
  const $ = load(Buffer.from(bytes).toString('utf8'));
  if ($('form[action*="takelogin"], input[type="password"]').length) throw new ResourceSiteError('authentication');
  if (
    $('#challenge-form, .cf-turnstile, iframe[src*="captcha"]').length
    || /just a moment|access denied|captcha|验证码/i.test($('title').text())
  )
    throw new ResourceSiteError('blocked');
  if (!$(HDAREA_SELECTORS.authenticated).length) throw new ResourceSiteError('authentication');
  return $;
}
export function parseSearch(
  bytes: Uint8Array,
  page: number,
  baseUrl = 'https://resource.invalid/'
): { releases: ResourceSiteRelease[]; nextPage?: number } {
  const $ = authenticatedDocument(bytes);
  const rows = $(HDAREA_SELECTORS.rows);
  if (
    !rows.length
    && !/没有种子|没有找到|沒有找到|没有符合|沒有符合|no torrents|no results|nothing found/i.test($.text())
  )
    throw new ResourceSiteError('invalidResponse');
  const releases: ResourceSiteRelease[] = [];
  for (const row of rows.toArray()) {
    const $row = $(row);
    const titled = $row.find('a[title][href^="details.php?id="]').first();
    const link = titled.length ? titled : $row.find('.torrentname').find(HDAREA_SELECTORS.title).first();
    const href = link.attr('href') ?? '';
    const id = new URL(href, baseUrl).searchParams.get('id');
    const title = (link.attr('title') || link.text()).trim();
    if (!id || !/^\d+$/.test(id) || !title) throw new ResourceSiteError('invalidResponse');
    const cells = $row.children('td');
    const sizeBytes = parseSize(cells.eq(-5).text());
    const seedersText = cells.eq(-4).text().replace(/[,\s]/g, '');
    const imdbId = $row.find('a[href*="imdb.com/title/tt"]').attr('href')?.match(/tt\d+/)?.[0];
    const timeCell = cells.eq(-6);
    const publishedAt = parsePublishedAt(timeCell.find('span[title]').attr('title') ?? timeCell.text());
    const titleCell = cells.filter((_index, cell) => $(cell).find('.torrentname').length > 0).first();
    const tags = releaseTags(title, ...tagEvidence($, titleCell));
    releases.push({
      id,
      title,
      ...(tags.length ? { tags } : {}),
      ...releaseTitleMetadata(title),
      ...(publishedAt ? { publishedAt } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(/^\d+$/.test(seedersText) ? { seeders: Number(seedersText) } : {}),
      ...(imdbId ? { imdbId } : {}),
    });
  }
  const nextPage = $('a[href*="torrents.php"][href*="page="]')
    .toArray()
    .some((a) => {
      try {
        const url = new URL($(a).attr('href')!, baseUrl);
        return (
          url.origin === new URL(baseUrl).origin
          && url.pathname === '/torrents.php'
          && url.searchParams.get('page') === String(page)
        );
      } catch {
        return false;
      }
    })
    ? page + 1
    : undefined;
  return { releases: [...new Map(releases.map((r) => [r.id, r])).values()], ...(nextPage ? { nextPage } : {}) };
}
export function parseDetail(bytes: Uint8Array, id: string): { release: ResourceSiteRelease } {
  const $ = authenticatedDocument(bytes);
  const heading = $('h1').first();
  const title = heading.clone().children().remove().end().text().trim() || heading.text().trim();
  if (!title) throw new ResourceSiteError('invalidResponse');
  const imdbId = $('a[href*="imdb.com/title/tt"]').first().attr('href')?.match(/tt\d+/)?.[0];
  const metadataRows = $('tr').filter((_index, row) => {
    return /^(?:副标题|副標題|标签|標籤|字幕|Subtitle|Tags)[:：]?$/i.test(
      $(row).children('td,th').first().text().trim()
    );
  });
  const tags = releaseTags(
    title,
    ...tagEvidence($, heading),
    ...tagEvidence($, $('#subtitle, .subtitle')),
    ...metadataRows.toArray().flatMap((row) => tagEvidence($, $(row).children('td,th').slice(1)))
  );
  return {
    release: {
      id,
      title,
      ...releaseTitleMetadata(title),
      ...(tags.length ? { tags } : {}),
      ...(imdbId ? { imdbId } : {}),
    },
  };
}
function parseSize(text: string): number | undefined {
  const match = text.replace(/,/g, '').match(/([\d.]+)\s*(B|[KMGT]i?B)/i);
  if (!match) return undefined;
  const value
    = Number(match[1])
      * 1024 ** ({ b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4 }[match[2]!.toLowerCase()] ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function parsePublishedAt(text: string): string | undefined {
  const match = text.trim().match(/^(\d{4}-\d{2}-\d{2})\s*(\d{2}:\d{2}:\d{2})$/);
  if (!match) return undefined;
  const value = `${match[1]}T${match[2]}+08:00`;
  const date = new Date(value);
  // Reject impossible dates instead of silently normalizing them, and never substitute the fetch time.
  if (
    !Number.isFinite(date.getTime())
    || new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`
  )
    return undefined;
  return `${match[1]} ${match[2]}`;
}

/** Read only the resource's metadata area, never page navigation or the full description. */
function tagEvidence($: CheerioAPI, scope: ReturnType<CheerioAPI>): string[] {
  const copy = scope.clone();
  copy.find('script, style').remove();
  copy.find('br').replaceWith('\n');
  const evidence = [copy.text()];
  copy.find('img, span, font, b, a[title]').each((_index, element) => {
    const node = $(element);
    evidence.push(node.attr('alt') ?? '', node.attr('title') ?? '', node.text());
  });
  return evidence;
}
