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
  'MTEAM_NOT_CONFIGURED',
  'MTEAM_INVALID_URL',
  'MTEAM_AUTH_FAILED',
  'MTEAM_UNREACHABLE',
  'MTEAM_TIMEOUT',
  'MTEAM_RATE_LIMITED',
  'MTEAM_UNEXPECTED_RESPONSE',
  'MTEAM_MOVIE_UNMATCHABLE',
  'MTEAM_CHECK_IN_PROGRESS',
  'MTEAM_SYNC_IN_PROGRESS',
  'MTEAM_SYNC_NOT_FOUND',
  'QBITTORRENT_NOT_CONFIGURED',
  'QBITTORRENT_INVALID_URL',
  'QBITTORRENT_AUTH_FAILED',
  'QBITTORRENT_UNREACHABLE',
  'QBITTORRENT_TIMEOUT',
  'QBITTORRENT_UNEXPECTED_RESPONSE',
  'MOVIE_DOWNLOAD_FAILED',
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
