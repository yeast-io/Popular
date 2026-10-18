import { aiStep } from '../../infrastructure/logging/ai-trace.js';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import type { LlmClient, LlmMessage } from '../llm/llm.types.js';
import { AssistantAgent, type AssistantAgentOptions } from './agents/assistant.agent.js';
import type { AssistantInputWorkflowMessage, AssistantIntent, AssistantWorkflow, AssistantWorkflowResult } from './assistant.type.js';

export const AssistantInputSchema = z.object({
  ownerId: z.string().min(1), channel: z.enum(['telegram', 'whatsapp']),
  chatId: z.string().min(1), messageId: z.string().min(1),
  text: z.string().trim().min(1).max(8_000), receivedAt: z.iso.datetime(),
});
const GraphState = Annotation.Root({
  input: Annotation<AssistantInputWorkflowMessage>(),
  intent: Annotation<AssistantIntent>(),
  replyText: Annotation<string>(),
});

export type AssistantRunnerOptions = AssistantAgentOptions;

/** A shared graph runner. Durable inbox storage and message delivery live outside the graph. */
export class AssistantWorkflowRunner implements AssistantWorkflow {
  constructor(
    private readonly createLlm: (ownerId: string) => Promise<Pick<LlmClient, 'generate'>>,
    private readonly options: AssistantRunnerOptions,
  )
  {
  }

  async run(raw: AssistantInputWorkflowMessage, history: LlmMessage[] = [], signal?: AbortSignal): Promise<AssistantWorkflowResult> {
    const input = AssistantInputSchema.parse(raw);
    // Resolve the owner's key once; never fall back to a shared system key.
    const llm = await aiStep('assistant.credentials.load', () => this.createLlm(input.ownerId));
    const agent = new AssistantAgent(llm, this.options);
    const graph = new StateGraph(GraphState)
      .addNode('assistant', state => agent.run(state.input, history, signal))
      .addEdge(START, 'assistant')
      .addEdge('assistant', END).compile();
    const result = await graph.invoke({ input }, { ...(signal ? { signal } : {}), recursionLimit: 5 });
    if (!result.replyText?.trim()) throw new Error('Assistant returned an empty reply');
    // Leave room below Telegram's UTF-16 text limit, even for surrogate pairs.
    const replyText = [...result.replyText].slice(0, 1_800).join('');
    return { replyText, intent: result.intent };
  }
}
