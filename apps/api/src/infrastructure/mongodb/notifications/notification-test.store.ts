import type { Model } from 'mongoose';
import type { NotificationTestStore } from '../../../modules/notifications/notification-test.service.js';
import type { MovieDownloadDocument } from '../downloads/movie-download.schema.js';
import { toMovieDownloadRecord } from '../downloads/movie-download.store.js';
const completed = { $or: [{ 'notificationTask.downloaded': true }, { progress: { $gte: 100 }, status: { $in: ['completed', 'seeding', 'paused'] } }] };
export class MongoNotificationTestStore implements NotificationTestStore {
  constructor(
    private readonly downloads: Model<MovieDownloadDocument>
  ) {}
  async listCompleted(ownerId: string, skip: number, limit: number) {
    const rows = await this.downloads.find({ ownerId, ...completed }).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean().exec();
    return rows.map(toMovieDownloadRecord);
  }
  async findCompleted(ownerId: string, id: string) {
    const row = await this.downloads.findOne({ ownerId, _id: id, ...completed }).lean().exec();
    return row ? toMovieDownloadRecord(row) : null;
  }
}
