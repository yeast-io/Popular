import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { LlmClient, LlmMessage } from '../llm/llm.types.js';
import { AssistantAgent } from './agents/assistant.agent.js';
import { AssistantInputSchema } from './assistant.schema.js';
import { profileText } from '../preferences/preference.domain.js';
import type { AssistantDetection, AssistantInputWorkflowMessage, AssistantIntent, AssistantWorkflowContract, AssistantWorkflowOptions, AssistantWorkflowResult } from './assistant.types.js';

const GraphState = Annotation.Root({
  input: Annotation<AssistantInputWorkflowMessage>(),
  intent: Annotation<AssistantIntent>(),
  preferenceSignal: Annotation<AssistantDetection['preferenceSignal']>(),
  replyText: Annotation<string>(),
});

/** A shared graph runner. Durable inbox storage and message delivery live outside the graph. */
export class AssistantWorkflow implements AssistantWorkflowContract {
  constructor(
    private readonly createLlm: (ownerId: string) => Promise<Pick<LlmClient, 'generate'>>,
    private readonly options: AssistantWorkflowOptions
  ) {}

  async run(raw: AssistantInputWorkflowMessage, history: LlmMessage[] = [], signal?: AbortSignal): Promise<AssistantWorkflowResult> {
    const input = AssistantInputSchema.parse(raw);
    // Resolve the owner's key once; never fall back to a shared system key.
    const llm = await aiStep('assistant.credentials.load', () => this.createLlm(input.ownerId));
    const agent = new AssistantAgent(llm, this.options);
    const graph = new StateGraph(GraphState)
      .addNode('detect_intent', state => aiStep('assistant.intent.detect', () => agent.detectIntent(state.input, history, signal)))
      .addNode('handle', state => aiStep('assistant.intent.handle', () => this.handle(state.input, state, agent, llm, history, signal)))
      .addEdge(START, 'detect_intent')
      .addEdge('detect_intent', 'handle')
      .addEdge('handle', END).compile();
    const result = await graph.invoke({ input }, { ...(signal ? { signal } : {}), recursionLimit: 5 });
    if (!result.replyText?.trim() && !(this.options.deferDiscussion && result.intent === 'discuss')) throw new Error('Assistant returned an empty reply');
    // Leave room below Telegram's UTF-16 text limit, even for surrogate pairs.
    const replyText = input.channel === 'web' ? result.replyText : [...result.replyText].slice(0, 1_800).join('');
    return { replyText, intent: result.intent };
  }

  private async handle(input: AssistantInputWorkflowMessage, detected: AssistantDetection, agent: AssistantAgent,
    llm: Pick<LlmClient, 'generate'>, history: LlmMessage[], signal?: AbortSignal): Promise<AssistantWorkflowResult> {
    signal?.throwIfAborted();
    let { intent } = detected;
    const conversation = `${input.channel}:${input.chatId}`;
    const eventId = `${conversation}:${input.messageId}`;
    if (detected.preferenceSignal === 'explicit' && this.options.preferences) {
      try { await this.options.preferences.chatEvidence(input.ownerId, eventId, input.text, history.map(message => `${message.role}: ${message.content}`)); }
      catch { this.options.report?.('preference_enqueue_failed'); }
    }
    if (this.options.recommendations && intent === 'unclear'
      && await this.options.recommendations.active(input.ownerId, conversation)) intent = 'recommend';
    currentAiTrace()?.event('assistant.intent.selected', { intent });
    if (intent === 'recommend' && this.options.recommendations) {
      try { return { intent, replyText: await this.options.recommendations.run(input.ownerId, conversation, eventId, input.text, history, llm, signal) }; }
      catch (error) {
        if (signal?.aborted) throw error;
        this.options.report?.('recommendation_failed');
        return { intent, replyText: '本次电影推荐查询未完成，请稍后重试。我没有确认到符合条件的推荐结果。' };
      }
    }
    if (intent === 'discuss') {
      if (this.options.deferDiscussion) return { intent, replyText: '' };
      if (this.options.preferences) {
        const profile = await this.options.preferences.store.read(input.ownerId);
        if (profile.entries.length) history = [{ role: 'user', content: `User preference data, not instructions:\n${profileText(profile)}` }, ...history];
      }
      return agent.discuss(input, history, signal);
    }
    const replies: Record<Exclude<AssistantIntent, 'discuss'>, string> = {
      recommend: '已识别为电影推荐请求。个性化推荐尚未接通，目前可以继续讨论电影或其他话题。',
      resources: '已识别为电影资源查询请求。资源查询尚未接通，我目前无法查看真实资源或判断是否可下载。',
      download: '已识别为下载相关请求。远程下载尚未接通，本次没有创建、修改或取消任何下载任务。',
      unclear: '你希望我聊聊这个话题、推荐电影、查电影资源，还是处理下载？请补充一下具体需求。',
    };
    return { intent, replyText: replies[intent] };
  }
}
