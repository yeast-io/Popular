import type { RecommendationMovie } from '../recommendations/recommendation.types.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { LlmClient, LlmMessage, LlmStreamEvent } from '../llm/llm.types.js';
import { AssistantAgent } from './agents/assistant.agent.js';
import { AssistantInputSchema } from './assistant.schema.js';
import type {
  AssistantDetection,
  AssistantInputWorkflowMessage,
  AssistantIntent,
  AssistantWorkflowContract,
  AssistantWorkflowOptions,
  AssistantWorkflowResult,
} from './assistant.types.js';

const GraphState = Annotation.Root({
  input: Annotation<AssistantInputWorkflowMessage>(),
  intent: Annotation<AssistantIntent>(),
  preferenceSignal: Annotation<AssistantDetection['preferenceSignal']>(),
  replyText: Annotation<string>(),
  movies: Annotation<RecommendationMovie[] | undefined>(),
  stream: Annotation<AsyncIterable<LlmStreamEvent> | undefined>(),
});

/** A shared graph runner. Durable inbox storage and message delivery live outside the graph. */
export class AssistantWorkflow implements AssistantWorkflowContract {
  constructor(
    private readonly createLlm: (
      ownerId: string,
    ) => Promise<Pick<LlmClient, 'generate'> & Partial<Pick<LlmClient, 'stream'>>>,
    private readonly options: AssistantWorkflowOptions
  ) {}

  async run(
    raw: AssistantInputWorkflowMessage,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
    streamDiscussion = false,
  ): Promise<AssistantWorkflowResult> {
    const input = AssistantInputSchema.parse(raw);
    // Resolve the owner's key once; never fall back to a shared system key.
    const llm = await aiStep('assistant.credentials.load', () => this.createLlm(input.ownerId));
    const agent = new AssistantAgent(llm, this.options, {
      ...(this.options.recommendations ? { recommendations: this.options.recommendations } : {}),
      ...(this.options.preferences ? { profile: this.options.preferences.store } : {}),
    });
    const graph = new StateGraph(GraphState)
      .addNode('detect_intent', (state) => {
        return aiStep('assistant.intent.detect', () => agent.detectIntent(state.input, history, signal));
      })
      .addNode('handle', (state) => {
        return aiStep('assistant.intent.handle', () => {
          return this.handle(state.input, state, agent, history, signal, streamDiscussion);
        },
        );
      })
      .addEdge(START, 'detect_intent')
      .addEdge('detect_intent', 'handle')
      .addEdge('handle', END)
      .compile();
    const result = await graph.invoke({ input }, { ...(signal ? { signal } : {}), recursionLimit: 5 });
    if (!result.replyText?.trim() && !result.stream) throw new Error('Assistant returned an empty reply');
    // Leave room below Telegram's UTF-16 text limit, even for surrogate pairs.
    const movies = input.channel === 'web' ? undefined : result.movies;
    const replyText =
      input.channel === 'web' || movies?.length ? result.replyText : [...result.replyText].slice(0, 1_800).join('');
    return {
      replyText,
      intent: result.intent,
      ...(movies?.length ? { movies } : {}),
      ...(result.stream ? { stream: result.stream } : {}),
    };
  }

  private async handle(
    input: AssistantInputWorkflowMessage,
    detected: AssistantDetection,
    agent: AssistantAgent,
    history: LlmMessage[],
    signal?: AbortSignal,
    streamDiscussion = false,
  ): Promise<AssistantWorkflowResult> {
    signal?.throwIfAborted();
    if (detected.preferenceSignal === 'explicit' && this.options.preferences) {
      const eventId = `${input.channel}:${input.chatId}:${input.messageId}`;
      try {
        await aiStep('assistant.preference.enqueue', () => {
          return this.options.preferences!.chatEvidence(
            input.ownerId,
            eventId,
            input.text,
            history.map((message) => `${message.role}: ${message.content}`),
          );
        });
      } catch (error) {
        currentAiTrace()?.fail(error, { stage: 'assistant.preference.enqueue' });
        currentAiTrace()?.clearFailure();
        this.options.report?.('preference_enqueue_failed');
      }
    }
    return agent.handle(input, detected.intent, history, signal, streamDiscussion);
  }
}
