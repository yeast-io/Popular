import type { LlmMessage } from './llm.types.js';
import { Utf8ByteTokenCounter } from './utf8-byte-token-counter.js';

/** Select recent conversation messages while reserving room for the system prompt and model output. */
export function buildLlmContext(
  prompt: string,
  text: string,
  history: LlmMessage[],
  maxContextTokens: number,
  reserve: number,
  userContext = ''
): LlmMessage[] {
  const counter = new Utf8ByteTokenCounter();
  const promptTokens = counter.count(prompt);
  const textTokens = counter.count(text);
  const contextTokens = userContext ? counter.count(userContext) + 4 : 0;
  let remaining = maxContextTokens - reserve - 256 - promptTokens - textTokens - contextTokens - 8;
  if (remaining < 0)
    throw new Error(
      `Assistant input exceeds the context budget (limit=${maxContextTokens}, prompt=${promptTokens}, input=${textTokens}, outputReserve=${reserve}, overhead=264)`
    );
  const selected: LlmMessage[] = [];
  for (const message of [...history].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const cost = counter.count(message.content) + 4;
    if (cost > remaining) break;
    selected.unshift(message);
    remaining -= cost;
  }
  return [
    { role: 'system', content: prompt },
    ...(userContext ? [{ role: 'user' as const, content: userContext }] : []),
    ...selected,
    { role: 'user', content: text },
  ];
}
