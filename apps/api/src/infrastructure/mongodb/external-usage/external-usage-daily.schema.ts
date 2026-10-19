import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';
import {
  EXTERNAL_PROVIDER_ID_MAX_LENGTH,
  EXTERNAL_PROVIDER_ID_PATTERN,
} from '../../../modules/external-usage/external-usage.types.js';

const externalUsageDailySchema = new Schema(
  {
    bucketDate: { type: Date, required: true },
    scopeKey: { type: String, required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
    provider: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: EXTERNAL_PROVIDER_ID_MAX_LENGTH,
      match: EXTERNAL_PROVIDER_ID_PATTERN,
    },
    operation: { type: String, required: true, maxlength: 80 },
    successCount: { type: Number, required: true, min: 0 },
    failureCount: { type: Number, required: true, min: 0 },
    totalDurationMs: { type: Number, required: true, min: 0 },
    maxDurationMs: { type: Number, required: true, min: 0 },
    tokenUsage: {
      type: new Schema(
        {
          inputTokens: { type: Number, required: true, min: 0 },
          outputTokens: { type: Number, required: true, min: 0 },
          cachedInputTokens: { type: Number, required: true, min: 0 },
          knownRequests: { type: Number, required: true, min: 0 },
          unknownRequests: { type: Number, required: true, min: 0 },
          unknownCachedRequests: { type: Number, required: true, min: 0 },
        },
        { _id: false },
      ),
      required: false,
    },
    expiresAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'external_usage_daily', versionKey: false },
);

externalUsageDailySchema.index({ bucketDate: 1, scopeKey: 1, provider: 1, operation: 1 }, { unique: true });
externalUsageDailySchema.index({ scopeKey: 1, bucketDate: -1, provider: 1 });
externalUsageDailySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type ExternalUsageDailyDocument = InferSchemaType<typeof externalUsageDailySchema> & {
  ownerId?: Types.ObjectId;
};

export const createExternalUsageDailyModel = (connection: Connection) => {
  return connection.model<ExternalUsageDailyDocument>('ExternalUsageDaily', externalUsageDailySchema);
};
