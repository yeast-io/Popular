import { isResourceSearchCacheValue } from './resource-search.schema.js';
import type { Locale, ResourceSiteSearch, ResourceSiteSearchResult } from '@movie-hub/contract';
import type { ResourceSearchCacheDependencies, ResourceSearchSource } from './resource-search.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { resourceSearchMessages } from './resource-search.messages.js';

export class ResourceSearchService {
  private readonly sources: ReadonlyMap<string, ResourceSearchSource>;

  constructor(
    sources: ResourceSearchSource[],
    private readonly enabledSites?: (ownerId: string) => Promise<string[]>,
    private readonly cacheDependencies?: ResourceSearchCacheDependencies
  ) {
    this.sources = new Map(sources.map((s) => [s.id, s]));
  }

  async list(ownerId: string) {
    const sources = await Promise.all(
      [...this.sources.values()].map(async (source) => {
        return {
          id: source.id,
          name: source.name,
          details: source.details,
          status: await aiStep('resource-search.source.status', () => source.status(ownerId), { source: source.id }),
        };
      })
    );
    return { sources };
  }

  async search(ownerId: string, id: string, input: ResourceSiteSearch, signal: AbortSignal, locale: Locale = 'en-US'): Promise<ResourceSiteSearchResult> {
    currentAiTrace()?.sensitive(input.query ?? '');
    signal.throwIfAborted();
    const source = this.source(id);
    if (this.enabledSites && !(await aiStep('resource-search.preferences.read', () => this.enabledSites!(ownerId))).includes(id))
      throw new AppError(400, 'INTEGRATION_DEFAULT_INVALID', resourceSearchMessages.en.disabledSource);
    signal.throwIfAborted();
    const { cacheOnly, refresh, ...sourceInput } = input;
    const fetch = () => aiStep('resource-search.source.search', () => source.search(ownerId, sourceInput, signal), { source: id, page: input.page ?? 1 });
    if (this.cacheDependencies && input.mediaType === 'tv' && input.query) {
      const credentialVersion = await aiStep('resource-search.credentials.version', () => this.cacheDependencies!.credentialVersion(ownerId, id), { source: id });
      if (credentialVersion !== undefined) {
        const query = {
          identity: { ownerId, site: id, mediaType: 'tv' as const, query: input.query.trim(), page: input.page ?? 1, locale, credentialVersion },
          validate: isResourceSearchCacheValue,
          force: refresh === true,
          fetch: async () => ({ ...await fetch(), cached: false, queriedAt: new Date().toISOString() }),
        };
        if (cacheOnly) return await this.cacheDependencies.cache.readCached(query) ?? { releases: [], cacheMiss: true };
        const result = await this.cacheDependencies.cache.getOrFetch(query);
        signal.throwIfAborted();
        return result;
      }
    }
    if (cacheOnly) return { releases: [], cacheMiss: true };
    return fetch();
  }

  async detail(ownerId: string, id: string, releaseId: string, signal: AbortSignal) {
    const source = this.source(id);
    if (!source.detail) throw new AppError(404, 'NOT_FOUND', resourceSearchMessages.en.unsupportedDetail);
    return aiStep('resource-search.source.detail', () => source.detail!(ownerId, releaseId, signal), { source: id });
  }

  private source(id: string) {
    const source = this.sources.get(id);
    if (!source) throw new AppError(404, 'NOT_FOUND', resourceSearchMessages.en.unknownSource);
    return source;
  }
}
