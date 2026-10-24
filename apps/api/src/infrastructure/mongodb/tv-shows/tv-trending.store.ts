import type { Locale } from '@movie-hub/contract';
import type { Models } from '../models.types.js';
import type { TvTrendingStore, TvTrendingSnapshot, TvShowCatalogStore } from '../../../modules/tv-shows/tv-show.types.js';
import { tvShowPolicy } from '../../../modules/tv-shows/tv-show.policy.js';

export class MongoTvTrendingStore implements TvTrendingStore {
  constructor(
    private readonly models: Pick<Models, 'tvShowResultSets' | 'tvShowTrendingStates'>,
    private readonly catalog: TvShowCatalogStore
  ) {}

  async readPage(page: number, locale: Locale, generation?: string): Promise<TvTrendingSnapshot | null> {
    const version = generation ?? (await this.models.tvShowTrendingStates.findOne({ locale, timeWindow: 'week' }).lean().exec())?.activeGeneration;
    if (!version)
      return null;
    const record = await this.models.tvShowResultSets.findOne({ locale, timeWindow: 'week', generation: version, page }).lean().exec();
    if (!record || (record.deleteAt && record.deleteAt.getTime() <= Date.now()))
      return null;
    const items = await this.catalog.readSummaries(record.tmdbIds, locale);
    if (items.length !== record.tmdbIds.length)
      return null;
    return { items, page, generation: version, totalPages: record.totalPages, totalResults: record.totalResults,
      fetchedAt: record.fetchedAt, freshUntil: record.freshUntil };
  }

  async readIds(locale: Locale, generation: string): Promise<number[]> {
    const pages = await this.models.tvShowResultSets.find({ locale, generation, timeWindow: 'week' }).lean().exec();
    return pages.flatMap((page) => page.tmdbIds);
  }

  async writePage(record: TvTrendingSnapshot, locale: Locale, publish: boolean): Promise<void> {
    const now = new Date();
    await this.catalog.upsertSummaries(record.items, locale, now);
    const { items, ...fields } = record;
    const filter = { type: 'trending', locale, timeWindow: 'week', generation: record.generation, page: record.page };
    // Retained generations stay finite even when an old browser extends them.
    const state = await this.models.tvShowTrendingStates.findOne({ locale, timeWindow: 'week' }).lean().exec();
    const oldGeneration = !publish && state?.activeGeneration !== record.generation;
    await this.models.tvShowResultSets.updateOne(filter, { $set: {
      ...filter, ...fields, key: `tv:trending:week:${locale}:${record.generation}:${record.page}`,
      tmdbIds: items.map((item) => item.tmdbId),
      ...(oldGeneration ? { deleteAt: new Date(now.getTime() + tvShowPolicy.snapshotRetentionMs) } : {}),
    } }, { upsert: true }).exec();
    if (publish) {
      await this.models.tvShowTrendingStates.updateOne({ locale, timeWindow: 'week' }, { $set: {
        activeGeneration: record.generation, publishedAt: now,
      } }, { upsert: true }).exec();
      await this.models.tvShowResultSets.updateMany({ locale, generation: { $ne: record.generation }, deleteAt: { $exists: false } }, {
        $set: { deleteAt: new Date(now.getTime() + tvShowPolicy.snapshotRetentionMs) },
      }).exec();
    }
  }
}
