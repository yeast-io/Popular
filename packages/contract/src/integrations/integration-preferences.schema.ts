import { Type, type Static } from '@sinclair/typebox';
import { IntegrationStatusSchema } from './integration.schema.js';

export const IntegrationCategorySchema = Type.Union((['resource', 'downloader', 'ai'] as const).map((id) => {
  return Type.Literal(id);
}));
const IntegrationIdSchema = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' });
export const IntegrationDefaultsSchema = Type.Object({
  resource: Type.Optional(IntegrationIdSchema),
  downloader: Type.Optional(IntegrationIdSchema),
  ai: Type.Optional(IntegrationIdSchema),
}, { additionalProperties: false });
export const IntegrationPreferencesSchema = Type.Object({
  defaults: IntegrationDefaultsSchema,
  selectedSites: Type.Array(IntegrationIdSchema, { uniqueItems: true, maxItems: 32 }),
  effectiveSites: Type.Array(IntegrationIdSchema),
  choices: Type.Array(Type.Object({
    id: IntegrationIdSchema, name: Type.String(), category: IntegrationCategorySchema, status: IntegrationStatusSchema,
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export const SetIntegrationDefaultSchema = Type.Object({
  category: IntegrationCategorySchema, id: IntegrationIdSchema,
}, { additionalProperties: false });
export const SetResourceSelectionSchema = Type.Object({
  sites: Type.Array(IntegrationIdSchema, { uniqueItems: true, maxItems: 32 }),
}, { additionalProperties: false });
export type IntegrationCategory = Static<typeof IntegrationCategorySchema>;
export type IntegrationDefaults = Static<typeof IntegrationDefaultsSchema>;
export type IntegrationPreferences = Static<typeof IntegrationPreferencesSchema>;
export type SetIntegrationDefault = Static<typeof SetIntegrationDefaultSchema>;
export type SetResourceSelection = Static<typeof SetResourceSelectionSchema>;
