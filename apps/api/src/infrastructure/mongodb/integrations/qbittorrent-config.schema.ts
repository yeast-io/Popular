import { Schema, type Connection, type InferSchemaType, type Types } from 'mongoose';

const qbittorrentConfigSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    downloaderInstanceId: { type: String, required: true },
    name: { type: String, required: true },
    baseUrl: { type: String, required: true },
    authMethod: { type: String, required: true, enum: ['api_key', 'username_password'] },
    username: { type: String },
    encryptedCredential: { type: String, required: true, select: false },
    version: { type: String },
    verifiedAt: { type: Date },
    lastValidationAt: { type: Date },
    lastFailureType: { type: String },
  },
  { timestamps: true, collection: 'qbittorrent_configs' }
);
qbittorrentConfigSchema.index({ ownerId: 1, downloaderInstanceId: 1 }, { unique: true });

export type QBittorrentConfigDocument = InferSchemaType<typeof qbittorrentConfigSchema> & { ownerId: Types.ObjectId };
export const createQBittorrentConfigModel = (connection: Connection) => {
  return connection.model<QBittorrentConfigDocument>('QBittorrentConfig', qbittorrentConfigSchema);
};
