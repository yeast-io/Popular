import { z } from 'zod';

const id = z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d{0,31}$/)]).transform(String);
export const hdareaEnvelopeSchema = z.object({
  success: z.boolean(),
  code: z.union([z.number(), z.string()]),
  data: z.unknown(),
});
export const hdareaProfileSchema = z.object({ id });
export const hdareaReleaseSchema = z.object({
  id,
  name: z.string().trim().min(1).max(512),
  small_descr: z.string().nullish(),
  size: z.number().nonnegative().safe().nullish(),
  seeders: z.number().int().nonnegative().nullish(),
  imdb_id: z.string().nullish(),
  added_ts: z.number().int().nonnegative().nullish(),
  medium_name: z.string().nullish(),
  codec_name: z.string().nullish(),
  audiocodec_name: z.string().nullish(),
  standard_name: z.string().nullish(),
  team_name: z.string().nullish(),
  tags: z.array(z.union([z.string(), z.object({ name: z.string() })])).optional(),
});
export const hdareaSearchSchema = z.object({
  items: z.array(hdareaReleaseSchema).max(100),
  pagination: z.object({ page: z.number().int().nonnegative(), has_more: z.boolean() }),
});
export const hdareaTokenSchema = z.object({
  id,
  download_url: z.string().max(8192).url(),
  expires_in: z.number().positive(),
});
