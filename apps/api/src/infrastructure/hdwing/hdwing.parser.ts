import { load } from 'cheerio';
import type { ResourceSiteRelease } from '@movie-hub/contract';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';
import { ExternalUserIdSchema } from '../../modules/resource-sites/site-account-identity.schema.js';
import { releaseTags } from '../../modules/resource-sites/release-tags.domain.js';
import { releaseTitleMetadata } from '../../modules/resource-sites/release-metadata.domain.js';
import { HDWING_SELECTORS } from './hdwing.policy.js';

function document(bytes: Uint8Array) {
  const $ = load(Buffer.from(bytes).toString('utf8'));
  if ($('#challenge-form, .cf-turnstile, iframe[src*="captcha"]').length
    || /just a moment|access denied|captcha|验证码/i.test($('title').text()))
    throw new ResourceSiteError('blocked');
  if ($('form[action*="takelogin"], input[type="password"]').length
    || !$(HDWING_SELECTORS.currentUser).length) throw new ResourceSiteError('authentication');
  return $;
}

function siteUrl(href: string, baseUrl: string, pathname: string): URL {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    throw new ResourceSiteError('invalidResponse');
  }
  if (url.origin !== new URL(baseUrl).origin || url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== pathname) throw new ResourceSiteError('invalidResponse');
  return url;
}

export function parseAuthenticatedUserId(bytes: Uint8Array, baseUrl: string): string {
  const $ = document(bytes);
  const ids = new Set($(HDWING_SELECTORS.currentUser).toArray().map((link) => {
    const url = siteUrl($(link).attr('href') ?? '', baseUrl, '/userdetails.php');
    const id = ExternalUserIdSchema.safeParse(url.searchParams.get('id'));
    if (!id.success || url.searchParams.getAll('id').length !== 1) throw new ResourceSiteError('invalidResponse');
    return id.data;
  }));
  if (ids.size !== 1) throw new ResourceSiteError('invalidResponse');
  return [...ids][0]!;
}

export function parseSearch(bytes: Uint8Array, page: number, baseUrl: string) {
  const $ = document(bytes);
  const rows = $(HDWING_SELECTORS.rows);
  if (!rows.length && !/没有种子|没有找到|沒有找到|没有符合|沒有符合|无搜索结果|no torrents|no results|nothing found/i.test($('#site_content').text()))
    throw new ResourceSiteError('invalidResponse');
  const releases: ResourceSiteRelease[] = rows.toArray().map((row) => {
    const node = $(row);
    const link = node.find(HDWING_SELECTORS.title).first();
    const url = siteUrl(link.attr('href') ?? '', baseUrl, '/details.php');
    const id = url.searchParams.get('id');
    const title = (link.attr('title') || link.text()).trim();
    if (!id || !/^\d{1,32}$/.test(id) || url.searchParams.getAll('id').length !== 1 || !title)
      throw new ResourceSiteError('invalidResponse');
    const description = node.find('td.t_name h4').first().text().trim();
    const tags = releaseTags(title, description);
    const size = node.children('td.t_size').text().replace(/,/g, '').match(/([\d.]+)\s*([KMGT]i?B|B)/i);
    const sizeBytes = size ? Math.round(Number(size[1]) * 1024 ** ('BKMGT'.indexOf(size[2]![0]!.toUpperCase()))) : undefined;
    const seeders = node.children('td.t_torrents').text().replace(/[,\s]/g, '');
    const time = node.find('td.t_time span[title]').first().attr('title')?.trim();
    const publishedAt = absoluteTime(time);
    const imdbId = node.find('a[href*="imdb.com/title/tt"], a[href*="retriver.php"]').toArray()
      .map((a) => $(a).attr('href')?.match(/tt\d+/)?.[0]).find(Boolean);
    return {
      id, title, detailsUrl: new URL(`details.php?id=${id}`, baseUrl).href,
      ...releaseTitleMetadata(title),
      ...(description ? { description } : {}), ...(tags.length ? { tags } : {}),
      ...(sizeBytes !== undefined && Number.isFinite(sizeBytes) ? { sizeBytes } : {}),
      ...(/^\d+$/.test(seeders) ? { seeders: Number(seeders) } : {}),
      ...(publishedAt ? { publishedAt } : {}), ...(imdbId ? { imdbId } : {}),
    };
  });
  const hasNext = $('.page_nav a[href]').toArray().some((a) => {
    try {
      const url = siteUrl($(a).attr('href')!, new URL('torrents.php', baseUrl).href, '/torrents.php');
      return url.searchParams.getAll('page').length === 1 && url.searchParams.get('page') === String(page);
    } catch { return false; }
  });
  return { releases: [...new Map(releases.map((r) => [r.id, r])).values()], ...(hasNext ? { nextPage: page + 1 } : {}) };
}

function absoluteTime(value?: string): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return;
  const date = new Date(`${value.replace(' ', 'T')}+08:00`);
  if (Number.isFinite(date.getTime())
    && new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 19) === value.replace(' ', 'T')) return value;
}

export function parseDetail(bytes: Uint8Array, id: string): ResourceSiteRelease {
  const $ = document(bytes);
  const heading = $(HDWING_SELECTORS.detailTitle).first();
  const title = heading.clone().children().remove().end().text().trim();
  if (!title) throw new ResourceSiteError('invalidResponse');
  const description = heading.next('h3').text().trim();
  const tags = releaseTags(title, description);
  const imdbId = $('#site_content a[href*="imdb.com/title/tt"]').first().attr('href')?.match(/tt\d+/)?.[0];
  return { id, title, ...releaseTitleMetadata(title), ...(description ? { description } : {}),
    ...(tags.length ? { tags } : {}), ...(imdbId ? { imdbId } : {}) };
}

export function parseTorrentUrl(bytes: Uint8Array, id: string, externalUserId: string, baseUrl: string): string {
  const $ = document(bytes);
  const urls = new Set<string>();
  for (const a of $('#site_content a[href*="download.php"]').toArray()) {
    const url = siteUrl($(a).attr('href') ?? '', baseUrl, '/download.php');
    const hash = url.searchParams.get('hash');
    if (!hash) continue; // Cookie-only download buttons are not transferable to a downloader.
    const uid = url.searchParams.get('uid');
    if (!uid) continue;
    if (url.searchParams.getAll('hash').length !== 1 || url.searchParams.getAll('uid').length !== 1
      || uid !== externalUserId || !/^[A-Za-z0-9_.-]{1,2048}$/.test(hash)) throw new ResourceSiteError('invalidResponse');
    // The observed signed payload is version, torrent ID and user ID followed by a signature.
    const [payload, signature, ...extra] = hash.split('.');
    const decoded = Buffer.from(payload!, 'base64url').toString('utf8').split('\n');
    if (!signature || extra.length || decoded.length !== 3 || decoded[0] !== '1' || decoded[1] !== id
      || decoded[2] !== externalUserId) throw new ResourceSiteError('invalidResponse');
    urls.add(url.href);
  }
  if (urls.size !== 1) throw new ResourceSiteError('invalidResponse');
  return [...urls][0]!;
}
