import type { RemoteCommandModels } from './remote-command.schema.js';
import type { Model } from 'mongoose';
import type { MovieDownloadDocument } from '../downloads/movie-download.schema.js';
import { MISSING_DOWNLOAD_RETENTION_MS } from '../../../modules/downloads/movie-download.policy.js';

/** Allow explicit redownloads to retain earlier command history for the same download. */
export class MongoRemoteCommandIndexMigration {
  constructor(
    private readonly commands: RemoteCommandModels['commands'],
    private readonly downloads?: Model<MovieDownloadDocument>
  ) {}

  async migrate(): Promise<void> {
    // Build the replacement lookup index and retain commandId uniqueness before removing the legacy constraint.
    await this.commands.init();
    const indexes = await this.commands.collection.indexes();
    if (!indexes.some((index) => index.unique === true && index.key.commandId === 1 && Object.keys(index.key).length === 1))
      throw new Error('Remote command migration requires a unique commandId index');
    for (const index of indexes) {
      if (!index.unique || index.key.downloadId !== 1 || Object.keys(index.key).length !== 1 || !index.name) continue;
      try {
        await this.commands.collection.dropIndex(index.name);
      } catch (error) {
        // Another API process may have completed this exact migration concurrently.
        if ((error as { code?: number }).code !== 27) throw error;
      }
    }
    if (this.downloads) {
      for await (const row of this.downloads.find({ executionMode: 'remote', status: 'missing',
        remoteStatusState: 'deleted', expiresAt: { $exists: false } }).lean().cursor()) {
        if (!row.remoteRequest?.commandId) continue;
        const now = Date.now();
        await this.downloads.updateOne({ '_id': row._id, 'status': 'missing',
          'remoteRequest.commandId': row.remoteRequest?.commandId, 'expiresAt': { $exists: false } },
        { $set: { missingSince: new Date(now), expiresAt: new Date(now + MISSING_DOWNLOAD_RETENTION_MS) } }).exec();
        await this.commands.updateOne({ commandId: row.remoteRequest?.commandId, state: 'succeeded', retiredAt: { $exists: false } },
          { $set: { retiredAt: now }, $unset: { envelope: 1 } }).exec();
      }
    }
  }
}
