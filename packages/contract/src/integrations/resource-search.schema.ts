import { Type, type Static } from '@sinclair/typebox';
import { IntegrationStatusSchema } from './integration.schema.js';

export const ResourceSearchSourcesSchema = Type.Object({ sources: Type.Array(Type.Object({
  id: Type.String(), name: Type.String(), status: IntegrationStatusSchema, details: Type.Boolean(),
}, { additionalProperties: false })) }, { additionalProperties: false });
export type ResourceSearchSourceInfo = Static<typeof ResourceSearchSourcesSchema>['sources'][number];
