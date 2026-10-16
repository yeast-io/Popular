import type { TokenCounter } from '../conversations/conversation.types.js';

/**
 * Conservative model-independent estimate: one token per UTF-8 byte.
 * Replace this with a model-matched tokenizer before optimizing context usage.
 */
export class Utf8ByteTokenCounter implements TokenCounter {
  count(text: string): number {
    return Buffer.byteLength(text, 'utf8');
  }
}
