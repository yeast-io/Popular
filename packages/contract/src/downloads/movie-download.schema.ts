import { Static, Type } from '@sinclair/typebox';

export const DownloadSourceSchema = Type.Union([Type.Literal('mteam'), Type.Literal('hdarea')]);
export type DownloadSource = Static<typeof DownloadSourceSchema>;

export const DownloadProviderSchema = Type.Union([Type.Literal('qbittorrent'), Type.Literal('transmission')]);
export type DownloadProvider = Static<typeof DownloadProviderSchema>;
export const DownloaderInstanceIdSchema = Type.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' });
export const DownloaderChoiceSchema = Type.Object({
  downloaderInstanceId: DownloaderInstanceIdSchema,
  provider: DownloadProviderSchema,
  name: Type.String({ minLength: 1, maxLength: 80 }),
}, { additionalProperties: false });
export type DownloaderChoice = Static<typeof DownloaderChoiceSchema>;

export const DownloadProviderListResponseSchema = Type.Object(
  {
    providers: Type.Array(DownloaderChoiceSchema),
  },
  { additionalProperties: false }
);
export type DownloadProviderListResponse = Static<typeof DownloadProviderListResponseSchema>;

export const MovieDownloadStatusSchema = Type.Union([
  Type.Literal('submitting'),
  Type.Literal('downloading'),
  Type.Literal('paused'),
  Type.Literal('seeding'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('missing'),
]);

export const MovieDownloadSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    tmdbId: Type.Integer({ minimum: 1 }),
    sourceProvider: DownloadSourceSchema,
    sourceReleaseId: Type.String({ minLength: 1 }),
    provider: DownloadProviderSchema,
    downloaderInstanceId: Type.Optional(DownloaderInstanceIdSchema),
    downloaderName: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    status: MovieDownloadStatusSchema,
    progress: Type.Number({ minimum: 0, maximum: 100 }),
    downloadedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    totalBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    downloadSpeed: Type.Optional(Type.Integer({ minimum: 0 })),
    etaSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    lastErrorCode: Type.Optional(Type.String({ minLength: 1 })),
    addedAt: Type.Optional(Type.String({ format: 'date-time' })),
    lastSyncedAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false }
);

export const MovieDownloadListResponseSchema = Type.Object(
  {
    items: Type.Array(MovieDownloadSchema),
  },
  { additionalProperties: false }
);

export const CreateMovieDownloadRequestSchema = Type.Object(
  {
    provider: Type.Optional(DownloadProviderSchema),
    downloaderInstanceId: Type.Optional(DownloaderInstanceIdSchema),
    sourceProvider: Type.Optional(DownloadSourceSchema),
    sourceReleaseId: Type.String({ minLength: 1, maxLength: 128, pattern: '^\\d+$' }),
  },
  { additionalProperties: false }
);

export type MovieDownloadStatus = Static<typeof MovieDownloadStatusSchema>;
export type MovieDownload = Static<typeof MovieDownloadSchema>;
export type MovieDownloadListResponse = Static<typeof MovieDownloadListResponseSchema>;
export type CreateMovieDownloadRequest = Static<typeof CreateMovieDownloadRequestSchema>;
