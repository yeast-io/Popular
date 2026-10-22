import { Schema, type Connection, type InferSchemaType } from 'mongoose';

const integrationPreferencesSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    defaults: {
      resource: { type: String },
      downloader: { type: String },
      ai: { type: String },
    },
    selectedSites: { type: [String], default: [] },
  },
  { collection: 'integration_preferences', timestamps: true }
);
integrationPreferencesSchema.index({ ownerId: 1 }, { unique: true });
export type IntegrationPreferencesDocument = InferSchemaType<typeof integrationPreferencesSchema>;
export const createIntegrationPreferencesModel = (connection: Connection) => {
  return connection.model('IntegrationPreferences', integrationPreferencesSchema);
};
