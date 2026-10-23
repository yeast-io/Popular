import { Static, Type } from '@sinclair/typebox';
import { LocaleSchema } from '../common/locale.schema.js';

export const UpdateProfileRequestSchema = Type.Object(
  {
    displayName: Type.String({ minLength: 1, maxLength: 80 }),
  },
  { additionalProperties: false }
);

export type UpdateProfileRequest = Static<typeof UpdateProfileRequestSchema>;

export const UpdateUserLocaleRequestSchema = Type.Object({ locale: LocaleSchema }, { additionalProperties: false });
export type UpdateUserLocaleRequest = Static<typeof UpdateUserLocaleRequestSchema>;
