import type { ResourceSiteSearch } from '@movie-hub/contract';
import type { ResourceSiteAdapter, ResourceSiteSession } from '../../modules/resource-sites/resource-site.types.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';
import { parseAuthenticatedUserId, parseDetail, parseSearch, parseTorrentUrl } from './hdwing.parser.js';

export class HDWingAdapter implements ResourceSiteAdapter {
  readonly id = 'hdwing';
  readonly name = 'HDWing';
  readonly requiresPasskey = false;
  readonly baseUrl: string;

  constructor(baseUrl: string) { this.baseUrl = new URL('/', baseUrl).href; }

  detailsUrl(id: string): string { return new URL(`details.php?id=${encodeURIComponent(id)}`, this.baseUrl).href; }

  async verify(session: ResourceSiteSession, signal?: AbortSignal): Promise<string> {
    return parseAuthenticatedUserId(await session.get('index.php', signal), this.baseUrl);
  }

  async search(session: ResourceSiteSession, input: ResourceSiteSearch, signal?: AbortSignal) {
    if (!input.imdbId && !input.query?.trim()) throw new ResourceSiteError('invalidResponse');
    const page = input.page ?? 1;
    const params = new URLSearchParams({ search: input.imdbId ?? input.query!.trim(),
      search_area: input.imdbId ? '4' : '0', search_mode: '0', incldead: '0', allsec: '1', page: String(page - 1) });
    return parseSearch(await session.get(`torrents.php?${params}`, signal), page, this.baseUrl);
  }

  async detail(session: ResourceSiteSession, id: string, signal?: AbortSignal) {
    this.validateId(id);
    const release = parseDetail(await session.get(`details.php?id=${id}`, signal), id);
    return { ...release, detailsUrl: this.detailsUrl(id) };
  }

  async resolveTorrentUrl(session: ResourceSiteSession, id: string, externalUserId: string, signal?: AbortSignal) {
    this.validateId(id);
    return parseTorrentUrl(await session.get(`details.php?id=${id}`, signal), id, externalUserId, this.baseUrl);
  }

  private validateId(id: string) {
    if (!/^\d{1,32}$/.test(id)) throw new ResourceSiteError('invalidResponse');
  }
}
