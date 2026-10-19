import { z } from 'zod';

const ChangeSchema = z.strictObject({
  operation: z.enum(['add', 'replace', 'remove']),
  entryId: z.string().nullable(),
  section: z.enum(['explicit', 'inferred']),
  content: z.string().max(500),
  evidenceRefs: z.array(z.string()).min(1).max(20),
  reason: z.string().max(500),
});

export const ProposalSchema = z.strictObject({ changes: z.array(ChangeSchema).max(20) });
