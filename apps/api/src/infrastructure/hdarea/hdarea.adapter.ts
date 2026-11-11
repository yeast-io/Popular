import type { ResourceSiteSearch } from '@movie-hub/contract';
import type { ResourceSiteAdapter, ResourceSiteSession } from '../../modules/resource-sites/resource-site.types.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';
import { authenticatedDocument, parseAuthenticatedUserId, parseSearch, parseDetail } from './hdarea.parser.js';

export class HDAreaAdapter implements ResourceSiteAdapter {
  readonly id = 'hdarea';
  readonly name = 'HDArea';
  readonly requiresPasskey = false;
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = new URL('/', baseUrl).href;
  }

  detailsUrl(id: string): string {
    return new URL(`details.php?id=${encodeURIComponent(id)}`, this.baseUrl).href;
  }

  async torrentFile(session: ResourceSiteSession, id: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!/^\d{1,32}$/.test(id)) throw new ResourceSiteError('invalidResponse');
    const $ = authenticatedDocument(await session.get(`details.php?id=${id}`, signal));
    const links = new Set<string>();
    for (const link of $('a[href*="download.php"]').toArray()) {
      const url = new URL($(link).attr('href') ?? '', this.baseUrl);
      if (url.origin !== new URL(this.baseUrl).origin || url.pathname !== '/download.php'
        || url.username || url.password || url.hash) throw new ResourceSiteError('invalidResponse');
      if (url.searchParams.getAll('id').length !== 1 || url.searchParams.get('id') !== id) continue;
      // Only use the site's Cookie download endpoint; never reuse embedded credentials.
      if ([...url.searchParams.keys()].some((key) => key !== 'id')) continue;
      links.add(url.href);
    }
    if (links.size !== 1) throw new ResourceSiteError('invalidResponse');
    return session.get([...links][0]!, signal);
  }

  async verify(session: ResourceSiteSession, signal?: AbortSignal): Promise<string> {
    return parseAuthenticatedUserId(await session.get('index.php', signal), this.baseUrl);
  }

  async search(session: ResourceSiteSession, input: ResourceSiteSearch, signal?: AbortSignal) {
    if (!input.imdbId && !input.query?.trim()) throw new ResourceSiteError('invalidResponse');
    const page = input.page ?? 1;
    const params = new URLSearchParams({
      search: input.imdbId ?? input.query!,
      incldead: '1',
      search_area: '0',
      search_mode: '0',
      sort: '7',
      type: 'desc',
      notnewword: '1',
      page: String(page - 1),
    });
    const result = parseSearch(await session.get(`torrents.php?${params}`, signal), page, this.baseUrl);
    return { ...result, releases: result.releases.map((release) => ({ ...release, detailsUrl: this.detailsUrl(release.id) })) };
  }

  async detail(session: ResourceSiteSession, id: string, signal?: AbortSignal) {
    return (await this.resolve(session, id, signal)).release;
  }

  private async resolve(session: ResourceSiteSession, id: string, signal?: AbortSignal) {
    if (!/^\d{1,32}$/.test(id)) throw new ResourceSiteError('invalidResponse');
    return parseDetail(await session.get(`details.php?id=${id}`, signal), id);
  }
}
