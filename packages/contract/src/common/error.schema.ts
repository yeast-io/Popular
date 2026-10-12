import { Static, Type } from '@sinclair/typebox';

export const errorCodes = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'TRENDING_NOT_SYNCED',
  'TRENDING_SYNC_IN_PROGRESS',
  'INTEGRATION_VALIDATION_FAILED',
] as const;

export const ErrorCodeSchema = Type.Union(errorCodes.map((code) => Type.Literal(code)));

export const ApiErrorSchema = Type.Object(
  {
    error: Type.Object({
      code: ErrorCodeSchema,
      message: Type.String(),
      requestId: Type.String(),
      details: Type.Optional(Type.Unknown()),
    }, { additionalProperties: false }),
  },
  { $id: 'ApiError', additionalProperties: false },
);

export type ErrorCode = Static<typeof ErrorCodeSchema>;
export type ApiError = Static<typeof ApiErrorSchema>;
