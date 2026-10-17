import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';
import {
  EXTERNAL_PROVIDER_ID_MAX_LENGTH,
  EXTERNAL_PROVIDER_ID_PATTERN,
} from '../../../modules/external-usage/external-usage.types.js';

export const EXTERNAL_USAGE_RETENTION_DAYS = 90;

const externalRequestEventSchema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
  actorType: { type: String, required: true, enum: ['user', 'anonymous', 'system'] },
  provider: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    maxlength: EXTERNAL_PROVIDER_ID_MAX_LENGTH,
    match: EXTERNAL_PROVIDER_ID_PATTERN,
  },
  operation: { type: String, required: true, maxlength: 80 },
  trigger: {
    type: String,
    required: true,
    enum: ['api_request', 'scheduled_sync', 'background_check', 'manual_refresh', 'retry'],
  },
  outcome: { type: String, required: true, enum: ['success', 'failure'] },
  httpStatus: { type: Number, min: 100, max: 599 },
  errorCode: {
    type: String,
    enum: [
      'authentication', 'permission', 'network', 'timeout', 'rate_limited',
      'invalid_response', 'remote_error', 'internal_error',
    ],
  },
  durationMs: { type: Number, required: true, min: 0 },
  operationId: { type: String, required: true, maxlength: 80 },
  attempt: { type: Number, required: true, min: 1 },
  occurredAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { collection: 'external_request_events', versionKey: false });

externalRequestEventSchema.index({ ownerId: 1, occurredAt: -1, provider: 1 });
externalRequestEventSchema.index({ occurredAt: -1, provider: 1, operation: 1 });
externalRequestEventSchema.index(
  { operationId: 1, provider: 1, operation: 1, attempt: 1 },
  { unique: true },
);
externalRequestEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type ExternalRequestEventDocument = InferSchemaType<typeof externalRequestEventSchema> & {
  ownerId?: Types.ObjectId;
};

export const createExternalRequestEventModel = (connection: Connection) =>
  connection.model<ExternalRequestEventDocument>('ExternalRequestEvent', externalRequestEventSchema);
