import { FormatRegistry, Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ResourceSiteSearchResultSchema } from '@movie-hub/contract';

if (!FormatRegistry.Has('date-time'))
  FormatRegistry.Set('date-time', (value) => Number.isFinite(Date.parse(value)));

if (!FormatRegistry.Has('uri'))
  FormatRegistry.Set('uri', (value) => URL.canParse(value));

export const ResourceSearchCacheSchema = Type.Object({
  ...ResourceSiteSearchResultSchema.properties,
  cached: Type.Boolean(),
  queriedAt: Type.String({ format: 'date-time' }),
}, { additionalProperties: false });
export type ResourceSearchCacheValue = Static<typeof ResourceSearchCacheSchema>;

export function isResourceSearchCacheValue(value: unknown): value is ResourceSearchCacheValue {
  return Value.Check(ResourceSearchCacheSchema, value);
}
