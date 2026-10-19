import type { ContextBuilderInput, ContextBuilderResult, ConversationMessage, TokenCounter } from './conversation.types.js';

export class ContextBudgetExceededError extends Error {
  constructor(
    message: string
  ) {
    super(message);
    this.name = 'ContextBudgetExceededError';
  }
}

export function buildConversationContext(input: ContextBuilderInput, tokenCounter: TokenCounter): ContextBuilderResult {
  const safetyMargin = input.safetyMarginTokens ?? 0;
  const messageOverhead = input.messageOverheadTokens ?? 4;
  if (input.maxContextTokens <= 0 || input.responseReserveTokens < 0 || safetyMargin < 0 || messageOverhead < 0) {
    throw new RangeError('Context token budgets must be non-negative and maxContextTokens must be positive');
  }

  const systemTokens = input.systemPrompt ? tokenCounter.count(input.systemPrompt) + messageOverhead : 0;
  const contextTokens = input.userContext ? tokenCounter.count(input.userContext) + messageOverhead : 0;
  const available = input.maxContextTokens - input.responseReserveTokens - safetyMargin - systemTokens - contextTokens;
  if (available < 0)
    throw new ContextBudgetExceededError('System prompt and reserved tokens exceed the context budget');

  const selected: ConversationMessage[] = [];
  let selectedTokens = 0;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (!message) continue;
    const tokens = tokenCounter.count(message.content) + messageOverhead;
    if (selectedTokens + tokens > available) {
      if (selected.length === 0)
        throw new ContextBudgetExceededError('The newest message exceeds the available context budget');
      break;
    }
    selected.push(message);
    selectedTokens += tokens;
  }

  selected.reverse();
  return {
    messages: [
      ...(input.systemPrompt ? [{ role: 'system' as const, content: input.systemPrompt }] : []),
      ...(input.userContext ? [{ role: 'user' as const, content: input.userContext }] : []),
      ...selected.map(({ role, content }) => ({ role, content })),
    ],
    usedTokens: systemTokens + contextTokens + selectedTokens,
    omittedMessageCount: input.messages.length - selected.length,
  };
}
