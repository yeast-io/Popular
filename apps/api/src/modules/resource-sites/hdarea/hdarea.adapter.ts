import type { ResourceSiteSearch } from '@movie-hub/contract';
import type { ResourceSiteAdapter, ResourceSiteSession } from '../resource-site.types.js';
import { ResourceSiteError } from '../resource-site.errors.js';
import { authenticatedDocument, parseSearch, parseDetail } from './hdarea.parser.js';

export class HDAreaAdapter implements ResourceSiteAdapter {
  readonly id = 'hdarea';
  readonly name = 'HDArea';
  readonly baseUrl: string;
  constructor(
    baseUrl: string
  ) {
    this.baseUrl = new URL('/', baseUrl).href;
  }
  detailsUrl(id: string): string { return new URL(`details.php?id=${encodeURIComponent(id)}`, this.baseUrl).href; }
  torrentUrl(id: string, passkey: string): string {
    if (!/^\d{1,32}$/.test(id) || !passkey || /[\s\r\n]/.test(passkey)) throw new ResourceSiteError('invalidCredential');
    const url = new URL('download.php', this.baseUrl);
    url.searchParams.set('id', id);
    url.searchParams.set('passkey', passkey);
    return url.href;
  }
  async verify(session: ResourceSiteSession, signal?: AbortSignal): Promise<void> {
    authenticatedDocument(await session.get('index.php', signal));
  }
  async search(session: ResourceSiteSession, input: ResourceSiteSearch, signal?: AbortSignal) {
    if (!input.imdbId && !input.query?.trim()) throw new ResourceSiteError('invalidResponse');
    const page = input.page ?? 1;
    const params = new URLSearchParams({ search: input.imdbId ?? input.query!, incldead: '1', search_area: '0',
      search_mode: '0', sort: '7', type: 'desc', notnewword: '1', page: String(page - 1) });
    return parseSearch(await session.get(`torrents.php?${params}`, signal), page, this.baseUrl);
  }
  async detail(session: ResourceSiteSession, id: string, signal?: AbortSignal) {
    return (await this.resolve(session, id, signal)).release;
  }
  private async resolve(session: ResourceSiteSession, id: string, signal?: AbortSignal) {
    if (!/^\d{1,32}$/.test(id)) throw new ResourceSiteError('invalidResponse');
    return parseDetail(await session.get(`details.php?id=${id}`, signal), id);
  }
}
