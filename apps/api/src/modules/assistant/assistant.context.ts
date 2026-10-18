import type { LlmMessage } from '../llm/llm.types.js';
import { Utf8ByteTokenCounter } from '../llm/utf8-byte-token-counter.js';

/** Select recent conversation messages while reserving room for the system prompt and model output. */
export function buildAssistantContext(
  prompt: string,
  text: string,
  history: LlmMessage[],
  maxContextTokens: number,
  reserve: number,
): LlmMessage[] {
  const counter = new Utf8ByteTokenCounter();
  let remaining = maxContextTokens - reserve - 256 - counter.count(prompt) - counter.count(text) - 8;
  if (remaining < 0) throw new Error('Assistant input exceeds the context budget');
  const selected: LlmMessage[] = [];
  for (const message of [...history].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const cost = counter.count(message.content) + 4;
    if (cost > remaining) break;
    selected.unshift(message); remaining -= cost;
  }
  return [{ role: 'system', content: prompt }, ...selected, { role: 'user', content: text }];
}
