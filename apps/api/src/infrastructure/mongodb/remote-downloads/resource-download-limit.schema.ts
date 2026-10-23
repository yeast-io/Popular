import { Schema, type Connection } from 'mongoose';
import type { ResourceDownloadLimit } from '../../../modules/resource-sites/resource-download-limit.types.js';

export const resourceDownloadLimitSchema = new Schema<ResourceDownloadLimit>({
  ownerId: { type: String, required: true },
  source: { type: String, required: true },
  resourceId: { type: String, required: true },
  kind: { type: String, enum: ['torrent_daily_limit'], required: true },
  detectedAt: { type: Number, required: true },
  retryAt: { type: Number, required: true },
}, { collection: 'resource_download_limits', versionKey: false });
resourceDownloadLimitSchema.index({ ownerId: 1, source: 1, resourceId: 1 }, { unique: true });
resourceDownloadLimitSchema.index({ retryAt: 1 });
export function createResourceDownloadLimitModel(connection: Connection) {
  return connection.model<ResourceDownloadLimit>('ResourceDownloadLimit', resourceDownloadLimitSchema);
}
