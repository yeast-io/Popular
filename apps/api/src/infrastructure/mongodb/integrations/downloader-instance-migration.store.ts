import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import type { QBittorrentConfigDocument } from './qbittorrent-config.schema.js';
import type { TransmissionConfigDocument } from './transmission-config.schema.js';
import type { MovieDownloadDocument } from '../downloads/movie-download.schema.js';
import type { IntegrationPreferencesDocument } from './integration-preferences.schema.js';

/** Restartable migration from one configuration per provider to named instances. */
export class MongoDownloaderInstanceMigration {
  constructor(
    private readonly qbittorrent: Model<QBittorrentConfigDocument>,
    private readonly transmission: Model<TransmissionConfigDocument>,
    private readonly downloads: Model<MovieDownloadDocument>,
    private readonly preferences: Model<IntegrationPreferencesDocument>
  ) {}

  async migrate(): Promise<number> {
    let migrated = 0;
    for await (const row of this.qbittorrent.find().select('ownerId downloaderInstanceId name').lean().cursor()) {
      const downloaderInstanceId = row.downloaderInstanceId || randomUUID();
      await this.qbittorrent.updateOne(
        { _id: row._id, downloaderInstanceId: { $exists: false } },
        { $set: { downloaderInstanceId, name: row.name || 'qBittorrent' } }
      ).exec();
      const current = await this.qbittorrent.findById(row._id).select('downloaderInstanceId name').lean().exec();
      if (!current?.downloaderInstanceId) throw new Error('qBittorrent instance migration failed');
      if (!current.name) await this.qbittorrent.updateOne({ _id: row._id }, { $set: { name: 'qBittorrent' } }).exec();
      await this.backfill(row.ownerId, 'qbittorrent', current.downloaderInstanceId, current.name || 'qBittorrent');
      migrated++;
    }
    for await (const row of this.transmission.find().select('ownerId downloaderInstanceId name').lean().cursor()) {
      const downloaderInstanceId = row.downloaderInstanceId || randomUUID();
      await this.transmission.updateOne(
        { _id: row._id, downloaderInstanceId: { $exists: false } },
        { $set: { downloaderInstanceId, name: row.name || 'Transmission' } }
      ).exec();
      const current = await this.transmission.findById(row._id).select('downloaderInstanceId name').lean().exec();
      if (!current?.downloaderInstanceId) throw new Error('Transmission instance migration failed');
      if (!current.name) await this.transmission.updateOne({ _id: row._id }, { $set: { name: 'Transmission' } }).exec();
      await this.backfill(row.ownerId, 'transmission', current.downloaderInstanceId, current.name || 'Transmission');
      migrated++;
    }
    await this.dropLegacyOwnerIndex();
    await Promise.all([this.qbittorrent.init(), this.transmission.init()]);
    return migrated;
  }

  private async backfill(
    ownerId: QBittorrentConfigDocument['ownerId'],
    provider: 'qbittorrent' | 'transmission',
    downloaderInstanceId: string,
    name: string
  ): Promise<void> {
    await this.downloads.updateMany(
      { ownerId, provider, executionMode: { $ne: 'remote' }, downloaderInstanceId: { $exists: false } },
      { $set: { downloaderInstanceId, downloaderName: name } }
    ).exec();
    await this.preferences.updateOne(
      { ownerId, 'defaults.downloader': provider },
      { $set: { 'defaults.downloader': downloaderInstanceId } }
    ).exec();
  }

  private async dropLegacyOwnerIndex(): Promise<void> {
    for (const model of [this.qbittorrent, this.transmission]) {
      let indexes;
      try {
        indexes = await model.collection.indexes();
      } catch (error) {
        if ((error as { code?: number }).code === 26) continue;
        throw error;
      }
      if (indexes.some((index) => index.name === 'ownerId_1' && index.unique === true)) {
        await model.collection.dropIndex('ownerId_1');
      }
    }
  }
}
