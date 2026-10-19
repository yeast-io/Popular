import { AiTrace, aiStep, withAiTrace, type AiLogger } from '../logging/ai-trace.js';
import type { AssistantMessageModel } from './assistant/assistant-message.schema.js';
import type { createResourceQueryModel } from './resource-query/resource-query.store.js';

export const ASSISTANT_MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const RESOURCE_QUERY_RETENTION_MS = 24 * 60 * 60_000;

/** Legacy updatedAt is an upper bound on completion time; absent dates retain from migration time. */
const dateOrNow = (field: string) => ({ $cond: [{ $eq: [{ $type: field }, 'date'] }, field, '$$NOW'] });

/** Idempotent and race-safe: only records still lacking an expiry are changed. No application-side deletion. */
export async function initializeAssistantRetention(
  messages: AssistantMessageModel,
  resources: ReturnType<typeof createResourceQueryModel>,
  diagnostics: { logger?: AiLogger; verbose: boolean },
): Promise<void> {
  const trace = new AiTrace(diagnostics.logger, {}, '', 'assistant.retention.initialize', diagnostics.verbose);
  await withAiTrace(trace, async () => {
    try {
      const messageAnchor = { $ifNull: ['$completedAt', dateOrNow('$updatedAt')] };
      const messageResult = await aiStep('assistant.retention.messages.backfill', () => {
        return messages.updateMany(
          { status: { $in: ['delivered', 'failed'] }, expiresAt: { $exists: false } },
          [{ $set: { completedAt: messageAnchor, expiresAt: { $add: [messageAnchor, ASSISTANT_MESSAGE_RETENTION_MS] } } }],
          { timestamps: false, hint: { expiresAt: 1 } },
        ).exec();
      });
      trace.event(
        'assistant.retention.messages.backfilled',
        { outcome: 'success', modifiedCount: messageResult.modifiedCount }
      );
      const resourceResult = await aiStep('assistant.retention.resources.backfill', () => {
        return resources.updateMany(
          { expiresAt: { $exists: false } },
          [{ $set: { expiresAt: { $add: [
            { $max: [dateOrNow('$updatedAt'), { $ifNull: ['$leaseUntil', dateOrNow('$updatedAt')] }] },
            RESOURCE_QUERY_RETENTION_MS,
          ] } } }],
          { timestamps: false, hint: { expiresAt: 1 } },
        ).exec();
      });
      trace.event(
        'assistant.retention.resources.backfilled',
        { outcome: 'success', modifiedCount: resourceResult.modifiedCount }
      );
    } catch (error) {
      trace.fail(error);
      throw error;
    }
  });
}
