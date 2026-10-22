import { Static, Type } from '@sinclair/typebox';

export const UpdateProfileRequestSchema = Type.Object(
  {
    displayName: Type.String({ minLength: 1, maxLength: 80 }),
  },
  { additionalProperties: false }
);

export type UpdateProfileRequest = Static<typeof UpdateProfileRequestSchema>;
