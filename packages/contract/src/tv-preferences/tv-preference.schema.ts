import { Type, type Static } from '@sinclair/typebox';
import { LocaleSchema } from '../common/locale.schema.js';
import { TrackedMoviePreferenceSchema } from '../movie-statuses/movie-status.schema.js';

export const TvPreferencesQuerySchema = Type.Object({
  preference: TrackedMoviePreferenceSchema,
  page: Type.Optional(Type.Integer({ minimum: 1, default: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  locale: Type.Optional(LocaleSchema),
}, { additionalProperties: false });

export type TvPreferencesQuery = Static<typeof TvPreferencesQuerySchema>;
