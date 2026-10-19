import { z } from 'zod';

export const EditSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  autoMaintain: z.boolean().optional(),
  entryId: z.string().min(1).max(100).optional(),
  content: z.string().trim().min(1).max(500).optional(),
  clear: z.boolean().optional(),
});
