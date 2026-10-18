import { z } from 'zod';

export const AssistantInputSchema = z.object({
  ownerId: z.string().min(1), channel: z.enum(['telegram', 'whatsapp', 'web']),
  chatId: z.string().min(1), messageId: z.string().min(1),
  text: z.string().trim().min(1).max(8_000), receivedAt: z.iso.datetime(),
});
