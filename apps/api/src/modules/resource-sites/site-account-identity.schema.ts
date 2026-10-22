import { z } from 'zod';

/** Preserve large site IDs as strings; reject unsafe JSON numbers and ambiguous values. */
export const ExternalUserIdSchema = z.union([
  z.string().regex(/^[0-9]{1,32}$/).transform((value) => BigInt(value).toString()),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String),
]).refine((value) => value !== '0');
