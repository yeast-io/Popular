import { z } from 'zod';
import { RECOMMENDATION_POLICY } from '../recommendations/recommendation.policy.js';

export const PlanSchema = z.strictObject({
  recommendNow: z.boolean(),
  requestedCount: z.number().int().min(1).max(RECOMMENDATION_POLICY.maxRecommendations),
  softPreferences: z.array(z.string().trim().min(1).max(200)).max(5),
  question: z.string().max(300).nullable(),
  genres: z.array(z.number().int()).max(5),
  excludeGenres: z.array(z.number().int()).max(5),
  referenceTitle: z.string().max(150).nullable(),
  maxRuntime: z.number().int().min(1).max(600).nullable(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .nullable(),
  unverifiableRestrictions: z.array(z.string().max(100)).max(5),
});

export const RankSchema = z.strictObject({
  movies: z
    .array(z.strictObject({ tmdbId: z.number().int().positive(), reason: z.string().min(1).max(220) }))
    .max(RECOMMENDATION_POLICY.maxRecommendations),
});

export const IntentResultSchema = z.strictObject({
  intent: z.enum(['discuss', 'recommend', 'resources', 'download', 'unclear']),
  preferenceSignal: z.enum(['none', 'explicit', 'uncertain']).default('none'),
  handling: z.enum(['answer', 'tool', 'clarify']).optional(),
  locale: z.enum(['zh-CN', 'en-US']).nullable().optional(),
});

export const ResourcePlanSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).nullable(),
  year: z.number().int().min(1870).max(2200).nullable(),
  candidateId: z.number().int().positive().nullable(),
  resolution: z.enum(['2160p', '1080p', '720p', 'any']).nullable(),
  providers: z.array(z.string().min(1).max(32)).max(10).nullable(),
  releaseIndex: z.number().int().min(1).max(100_000).nullable(),
  page: z.union([z.number().int().min(1).max(10_000), z.enum(['next', 'previous'])]).nullable(),
  refresh: z.boolean(),
  question: z.string().trim().min(1).max(300).nullable(),
  unsupported: z.array(z.string().max(100)).max(5),
});

export const DownloadActionSchema = z.strictObject({
  action: z.enum([
    'query',
    'select_resource',
    'select_provider',
    'cancel',
    'retry',
    'status',
    'answer',
    'other',
    'clarify',
  ]),
  releaseIndex: z.number().int().positive().nullable(),
  provider: z.enum(['qbittorrent', 'transmission']).nullable(),
});

export function createRecommendationRankSchema(requestedCount: number) {
  return RankSchema.extend({ movies: RankSchema.shape.movies.max(requestedCount) });
}
