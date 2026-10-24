import { z } from 'zod';

const id = z.number().int().positive();
const count = z.number().int().nonnegative();
const rating = z.number().min(0).max(10);
const text = z.string().nullish().transform((v) => v?.trim() || undefined);
const date = z.string().nullish().transform((v) => v || undefined).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const parsed = new Date(v);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}).optional());
const image = z.string().regex(/^\/[a-zA-Z0-9_.-]+\.(jpg|png|webp)$/i).nullish().transform((v) => v ?? undefined);
const genre = z.object({ id, name: z.string() });
export const TmdbTvSummarySchema = z.object({
  id, name: z.string(), original_name: text, original_language: text,
  overview: text, first_air_date: date, poster_path: image, backdrop_path: image,
  genre_ids: z.array(id).optional(), vote_average: rating.nullish(), vote_count: count.nullish(),
});
export const TmdbTvSeasonSummarySchema = z.object({
  id, season_number: count, name: z.string(), overview: text, poster_path: image,
  air_date: date, episode_count: count.nullish(), vote_average: rating.nullish(),
});
const video = z.object({
  id: z.string().trim().min(1), key: z.string().trim().regex(/^[A-Za-z0-9_-]+$/),
  site: z.literal('YouTube'), type: z.literal('Trailer'), name: z.string().trim().min(1),
  official: z.boolean().optional().default(false),
  iso_639_1: z.string().nullish(), iso_3166_1: z.string().nullish(),
  published_at: z.string().datetime({ offset: true }).optional(),
});
export type TmdbTvVideo = z.infer<typeof video>;
const videos = z.array(z.unknown()).transform((items) => items.flatMap((item) => {
  const parsed = video.safeParse(item);
  return parsed.success ? [parsed.data] : [];
}));
export const TmdbTvDetailSchema = TmdbTvSummarySchema.extend({
  tagline: text, last_air_date: date, status: text, in_production: z.boolean().optional(),
  number_of_seasons: count.nullish(), number_of_episodes: count.nullish(),
  videos: z.object({ results: videos }).optional(),
  genres: z.array(genre), seasons: z.array(TmdbTvSeasonSummarySchema),
});
export const TmdbTvEpisodeSchema = z.object({
  id, show_id: id.optional(), season_number: count, episode_number: z.number().int().positive(),
  name: z.string(), overview: text, still_path: image, episode_type: text,
  air_date: date, runtime: count.nullish(), vote_average: rating.nullish(), vote_count: count.nullish(),
});
export const TmdbTvSeasonSchema = TmdbTvSeasonSummarySchema.extend({ episodes: z.array(TmdbTvEpisodeSchema) });
export const TmdbTvTrendingSchema = z.object({
  page: z.number().int().positive(), total_pages: count, total_results: count,
  results: z.array(TmdbTvSummarySchema),
});
export type TmdbTvSummary = z.infer<typeof TmdbTvSummarySchema>;
export type TmdbTvSeasonSummary = z.infer<typeof TmdbTvSeasonSummarySchema>;
