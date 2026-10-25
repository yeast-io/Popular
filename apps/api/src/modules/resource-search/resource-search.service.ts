import type { ResourceSiteSearch } from '@movie-hub/contract';
import type { ResourceSearchSource } from './resource-search.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { resourceSearchMessages } from './resource-search.messages.js';

export class ResourceSearchService {
  private readonly sources: ReadonlyMap<string, ResourceSearchSource>;

  constructor(sources: ResourceSearchSource[], private readonly enabledSites?: (ownerId: string) => Promise<string[]>) {
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

  async search(ownerId: string, id: string, input: ResourceSiteSearch, signal: AbortSignal) {
    currentAiTrace()?.sensitive(input.query ?? '');
    signal.throwIfAborted();
    const source = this.source(id);
    if (this.enabledSites && !(await aiStep('resource-search.preferences.read', () => this.enabledSites!(ownerId))).includes(id))
      throw new AppError(400, 'INTEGRATION_DEFAULT_INVALID', resourceSearchMessages.en.disabledSource);
    signal.throwIfAborted();
    return aiStep(
      'resource-search.source.search',
      () => {
        return source.search(ownerId, input, signal);
      },
      { source: id, page: input.page ?? 1 }
    );
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
