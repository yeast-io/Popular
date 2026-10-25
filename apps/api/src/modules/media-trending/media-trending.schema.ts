import { z } from 'zod';
import { mediaTrendingPolicy } from './media-trending.policy.js';

export const mediaTrendingSnapshotSchema = z.object({
  generation: z.uuid(),
  fetchedAt: z.iso.datetime(),
  expiresAt: z.number().int().positive(),
  sourcePage: z.number().int().min(1).max(mediaTrendingPolicy.maxPage),
  pageSize: z.number().int().min(1),
  totalPages: z.number().int().min(0),
  totalResults: z.number().int().min(0),
  pendingIds: z.array(z.number().int().positive()),
  pages: z.array(z.array(z.number().int().positive())).min(1).max(mediaTrendingPolicy.maxPage),
}).strict();
export type MediaTrendingSnapshot = z.infer<typeof mediaTrendingSnapshotSchema>;
