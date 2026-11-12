import type { ResourceSiteSearch } from '@movie-hub/contract';
import type { ResourceSiteAdapter, ResourceSiteSession } from '../../modules/resource-sites/resource-site.types.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';
import { aiStep, currentAiTrace } from '../logging/ai-trace.js';
import { apiData, apiRelease } from './hdarea.parser.js';
import { hdareaProfileSchema, hdareaReleaseSchema, hdareaSearchSchema, hdareaTokenSchema } from './hdarea.schema.js';

export class HDAreaAdapter implements ResourceSiteAdapter {
  readonly id = 'hdarea';
  readonly name = 'HDArea';
  readonly requiresPasskey = false;
  readonly credentialType = 'apiKey';
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = new URL('/', baseUrl).href;
  }

  detailsUrl(id: string): string {
    return new URL(`details.php?id=${encodeURIComponent(id)}`, this.baseUrl).href;
  }

  async verify(session: ResourceSiteSession, signal?: AbortSignal): Promise<string> {
    const parsed = hdareaProfileSchema.safeParse(apiData(await session.get('/api/v1/user/profile', signal)));
    if (!parsed.success) throw new ResourceSiteError('invalidResponse', { cause: parsed.error });
    return parsed.data.id;
  }

  async search(session: ResourceSiteSession, input: ResourceSiteSearch, signal?: AbortSignal) {
    if (!input.imdbId && !input.query?.trim()) throw new ResourceSiteError('invalidResponse');
    const page = input.page ?? 1;
    const params = new URLSearchParams({
      page: String(page - 1),
      per_page: '50',
      incldead: '1',
      sort: 'seeders',
      order: 'desc',
    });
    if (input.imdbId) params.set('imdb', input.imdbId);
    else params.set('q', input.query!.trim());
    // Categories mix format and genre (animation/documentaries can be movies or TV).
    // Preserve cross-category searches; IMDb is the exact identity boundary.
    const parsed = hdareaSearchSchema.safeParse(apiData(await session.get(`/api/v1/torrents?${params}`, signal)));
    if (!parsed.success || parsed.data.pagination.page !== page - 1) throw new ResourceSiteError('invalidResponse');
    const releases = parsed.data.items.map((row) => apiRelease(row, this.baseUrl));
    if (input.imdbId && releases.some((row) => row.imdbId !== input.imdbId))
      throw new ResourceSiteError('invalidResponse');
    return { releases, ...(parsed.data.pagination.has_more && page < 100 ? { nextPage: page + 1 } : {}) };
  }

  async detail(session: ResourceSiteSession, id: string, signal?: AbortSignal) {
    this.validateId(id);
    const parsed = hdareaReleaseSchema.safeParse(apiData(await session.get(`/api/v1/torrents/${id}`, signal)));
    if (!parsed.success || parsed.data.id !== id) throw new ResourceSiteError('invalidResponse');
    return apiRelease(parsed.data, this.baseUrl);
  }

  async torrentFile(session: ResourceSiteSession, id: string, signal?: AbortSignal): Promise<Uint8Array> {
    this.validateId(id);
    if (!session.post) throw new ResourceSiteError('invalidResponse');
    for (let attempt = 0; attempt < 2; attempt++) {
      const parsed = hdareaTokenSchema.safeParse(
        apiData(
          await aiStep(
            'resource-sites.hdarea.download-token',
            () => session.post!('/api/v1/torrents/genDlToken', { id }, signal),
            { site: this.id, resourceId: id, attempt: attempt + 1 }
          )
        )
      );
      if (!parsed.success || parsed.data.id !== id) throw new ResourceSiteError('invalidResponse');
      currentAiTrace()?.sensitive(parsed.data.download_url);
      const url = new URL(parsed.data.download_url);
      for (const value of url.searchParams.values()) currentAiTrace()?.sensitive(value);
      if (
        url.origin !== new URL(this.baseUrl).origin
        || url.pathname !== '/download.php'
        || url.username
        || url.password
        || url.hash
        || url.searchParams.getAll('id').length !== 1
        || url.searchParams.get('id') !== id
        || url.searchParams.getAll('dl_token').length !== 1
        || !url.searchParams.get('dl_token')
        || [...url.searchParams.keys()].some((key) => /^(?:apikey|passkey)$/i.test(key))
      )
        throw new ResourceSiteError('invalidResponse');
      try {
        return await session.get(url.href, signal);
      } catch (cause) {
        if (attempt === 1 || !(cause instanceof ResourceSiteError) || cause.reason !== 'downloadExpired') throw cause;
        currentAiTrace()?.clearFailure();
        currentAiTrace()?.event('resource-sites.hdarea.download-token.refresh', {
          resourceId: id,
          attempt: attempt + 2,
        });
      }
    }
    throw new ResourceSiteError('downloadExpired');
  }

  private validateId(id: string): void {
    if (!/^[1-9]\d{0,31}$/.test(id)) throw new ResourceSiteError('invalidResponse');
  }
}
