import { AiTrace, withAiTrace, type AiLogger } from '../../infrastructure/logging/ai-trace.js';
import type { IncomingMessage } from '../incoming-message.js';
import type { AssistantConversation, AssistantQueue } from './assistant.queue.js';
import { AssistantInputSchema } from './assistant.schema.js';

/** Transport callbacks finish only after accepted text has been persisted. */
export class AssistantMessageReceiver {
  constructor(
    private readonly queue: Pick<AssistantQueue, 'enqueue'>,
    private readonly wake: (conversation: AssistantConversation) => void = () => undefined,
    private readonly logger?: AiLogger
  ) {}

  async receive(ownerId: string, message: IncomingMessage): Promise<void> {
    const trace = new AiTrace(
      this.logger,
      {
        event: 'assistant_receive',
        ownerId,
        channel: message.channel,
        chatId: message.chatId,
        messageId: message.messageId,
      },
      message.text ?? '',
      'assistant.receive',
    );
    await withAiTrace(trace, async () => {
      const skip = (reason: string) => trace.event('assistant.message.filtered', { reason });
      if (message.channel === 'whatsapp' && message.isSelfChat !== true) return skip('not_self_chat');
      if (!['text', 'conversation', 'extendedTextMessage'].includes(message.messageType))
        return skip('unsupported_message_type');
      if (!message.messageId) return skip('missing_message_id');
      if (!message.text?.trim()) return skip('empty_text');
      const input = await trace.step('assistant.input.validate', async () => {
        return AssistantInputSchema.parse({
          ownerId,
          channel: message.channel,
          chatId: message.chatId,
          messageId: message.messageId,
          text: message.text,
          receivedAt: new Date().toISOString(),
        }
        );
      });
      trace.sensitive(input.text);
      await trace.step('assistant.inbox.persist', () => this.queue.enqueue(input));
      this.wake(input);
      trace.event('assistant.worker.notified');
    }).catch((error) => {
      trace.fail(error);
      throw error;
    });
  }
}
