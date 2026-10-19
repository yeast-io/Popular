import { RESOURCE_QUERY_PLAN_PROMPT } from '../../../config/system-prompts/resource-query.prompts.js';
import type { ResourceDecisions, ResourcePlan } from '../../resource-query/resource-query.types.js';
import type { Locale, TasteProfile } from '@movie-hub/contract';
import { RECOMMENDATION_POLICY } from '../../recommendations/recommendation.policy.js';
import type { LlmGenerateInput, LlmStreamEvent } from '../../llm/llm.types.js';
import type { MovieDetailRecord } from '../../movies/movie.types.js';
import { profileText } from '../../preferences/preference.domain.js';
import type { RecommendationPlan, RankedMovie } from '../../recommendations/recommendation.types.js';
import {
  RECOMMENDATION_PLAN_SYSTEM_PROMPT,
  RECOMMENDATION_RANK_SYSTEM_PROMPT,
} from '../../../config/system-prompts/recommendation.prompts.js';

import { z } from 'zod';
import {
  ASSISTANT_INTENT_SYSTEM_PROMPT,
  buildAssistantDiscussionPrompt,
} from '../../../config/system-prompts/assistant.prompts.js';
import type { LlmClient, LlmMessage } from '../../llm/llm.types.js';
import { buildLlmContext } from '../../llm/llm.context.js';
import type {
  AssistantTools,
  AssistantAgentOptions,
  AssistantInputWorkflowMessage,
  AssistantIntent,
  AssistantWorkflowResult,
} from '../assistant.types.js';
import { aiStep, currentAiTrace } from '../../../infrastructure/logging/ai-trace.js';

const PlanSchema = z.strictObject({
  recommendNow: z.boolean(),
  requestedCount: z.number().int().min(1).max(RECOMMENDATION_POLICY.maxRecommendations),
  softPreferences: z.array(z.string().trim().min(1).max(200)).max(5),
  question: z.string().max(300).nullable(),
  genres: z.array(z.number().int()).max(5),
  excludeGenres: z.array(z.number().int()).max(5),
  referenceTitle: z.string().max(150).nullable(),
  maxRuntime: z.number().int().min(1).max(600).nullable(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .nullable(),
  unverifiableRestrictions: z.array(z.string().max(100)).max(5),
});
const RankSchema = z.strictObject({
  movies: z
    .array(z.strictObject({ tmdbId: z.number().int().positive(), reason: z.string().min(1).max(220) }))
    .max(RECOMMENDATION_POLICY.maxRecommendations),
});

const IntentResultSchema = z.strictObject({
  intent: z.enum(['discuss', 'recommend', 'resources', 'download', 'unclear']),
  preferenceSignal: z.enum(['none', 'explicit', 'uncertain']).default('none'),
});
const ResourcePlanSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).nullable(),
  year: z.number().int().min(1870).max(2200).nullable(),
  candidateId: z.number().int().positive().nullable(),
  resolution: z.enum(['2160p', '1080p', '720p', 'any']).nullable(),
  providers: z.array(z.string().min(1).max(32)).max(10).nullable(),
  releaseIndex: z.number().int().min(1).max(100_000).nullable(),
  page: z.union([z.number().int().min(1).max(10_000), z.enum(['next', 'previous'])]).nullable(),
  refresh: z.boolean(),
  question: z.string().trim().min(1).max(300).nullable(),
  unsupported: z.array(z.string().max(100)).max(5),
});
const OUTPUT_TOKEN_LIMIT = 256;

/** Shared model decisions and capability selection for every channel. Tools enforce business rules. */
export class AssistantAgent {
  constructor(
    private readonly llm: Pick<LlmClient, 'generate'> & Partial<Pick<LlmClient, 'stream'>>,
    private readonly options: AssistantAgentOptions,
    private readonly tools: AssistantTools = {}
  ) {}

  async detectIntent(
    input: AssistantInputWorkflowMessage,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
  ): Promise<{ intent: AssistantIntent; preferenceSignal: 'none' | 'explicit' | 'uncertain' }> {
    signal?.throwIfAborted();
    const result = await this.llm.generate({
      messages: buildLlmContext(
        ASSISTANT_INTENT_SYSTEM_PROMPT,
        input.text,
        history,
        this.options.maxContextTokens,
        OUTPUT_TOKEN_LIMIT,
      ),
      maxOutputTokens: OUTPUT_TOKEN_LIMIT,
      operation: 'assistant.intent',
      ...(signal ? { signal } : {}),
      outputSchema: {
        name: 'assistant_intent',
        schema: {
          type: 'object',
          properties: {
            intent: { type: 'string', enum: IntentResultSchema.shape.intent.options },
            preferenceSignal: { type: 'string', enum: ['none', 'explicit', 'uncertain'] },
          },
          required: ['intent', 'preferenceSignal'],
          additionalProperties: false,
        },
      },
    });
    signal?.throwIfAborted();
    // Provider failures, malformed JSON, and invalid values must not masquerade as unclear intent.
    currentAiTrace()?.sensitive(result.content);
    return IntentResultSchema.parse(JSON.parse(result.content));
  }

  async discuss(
    input: AssistantInputWorkflowMessage,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
    profileContext = '',
  ): Promise<AssistantWorkflowResult> {
    signal?.throwIfAborted();
    const result = await this.llm.generate(this.discussionRequest(input, history, signal, profileContext));
    signal?.throwIfAborted();
    if (!result.content.trim()) throw new Error('Assistant returned an empty reply');
    return { intent: 'discuss', replyText: result.content.trim() };
  }

  private discussionRequest(
    input: AssistantInputWorkflowMessage,
    history: LlmMessage[],
    signal?: AbortSignal,
    profileContext = '',
  ): LlmGenerateInput {
    return {
      messages: buildLlmContext(
        buildAssistantDiscussionPrompt(this.options.systemPrompt),
        input.text,
        history,
        this.options.maxContextTokens,
        this.options.maxOutputTokens,
        profileContext,
      ),
      maxOutputTokens: this.options.maxOutputTokens,
      operation: 'assistant.discuss',
      ...(signal ? { signal } : {}),
    };
  }

  async *streamDiscuss(
    input: AssistantInputWorkflowMessage,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
    profileContext = '',
  ): AsyncIterable<LlmStreamEvent> {
    signal?.throwIfAborted();
    if (!this.llm.stream) throw new Error('Assistant streaming client is unavailable');
    const trace = currentAiTrace();
    const started = Date.now();
    let content = '',
      completed = false;
    trace?.event('assistant.discuss.stream.started');
    try {
      for await (const event of this.llm.stream(this.discussionRequest(input, history, signal, profileContext))) {
        signal?.throwIfAborted();
        if (event.type === 'delta') content += event.delta;
        else completed = true;
        yield event;
      }
      trace?.sensitive(content);
      signal?.throwIfAborted();
      if (!content.trim() || !completed) throw new Error('Assistant returned an incomplete streaming reply');
      trace?.event('assistant.discuss.stream.completed', { durationMs: Date.now() - started, outcome: 'success' });
    } catch (error) {
      trace?.sensitive(content);
      trace?.fail(error, { stage: 'assistant.discuss.stream', durationMs: Date.now() - started });
      throw error;
    }
  }

  async handler(
    input: AssistantInputWorkflowMessage,
    intent: AssistantIntent,
    history: LlmMessage[] = [],
    signal?: AbortSignal,
    streamDiscussion = false,
  ): Promise<AssistantWorkflowResult> {
    signal?.throwIfAborted();
    const conversation = `${input.channel}:${input.chatId}`;
    if (intent === 'unclear' && this.tools.resources && await this.tools.resources.active(input.ownerId, conversation)) {
      intent = 'resources';
    }
    if (
      intent === 'unclear' &&
      this.tools.recommendations &&
      (await this.tools.recommendations.active(input.ownerId, conversation))
    ) { intent = 'recommend'; }
    currentAiTrace()?.event('assistant.intent.selected', { intent });
    if (intent === 'recommend' && this.tools.recommendations) {
      try {
        return {
          intent,
          ...(await aiStep('assistant.tool.recommendations', () => {
            return this.tools.recommendations!.runResult(
              input.ownerId,
              conversation,
              `${conversation}:${input.messageId}`,
              input.text,
              history,
              { plan: this.planRecommendation.bind(this), rank: this.rankRecommendations.bind(this) },
              signal,
            );
          })),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        // The tool logs the original error with its candidate/model redaction context.
        currentAiTrace()?.event('assistant.tool.recommendations.failed', { outcome: 'failure' });
        currentAiTrace()?.clearFailure();
        return { intent, replyText: '本次电影推荐查询未完成，请稍后重试。我没有确认到符合条件的推荐结果。' };
      }
    }
    if (intent === 'resources' && this.tools.resources) {
      try {
        return {
          intent,
          ...(await aiStep('assistant.tool.resources', () => {
            return this.tools.resources!.run(
              input.ownerId, conversation, `${conversation}:${input.messageId}`, input.text, history,
              { plan: this.planResources.bind(this) }, signal,
            );
          })),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        // The capability records the original failure using its redaction and correlation context.
        currentAiTrace()?.event('assistant.tool.resources.failed', { outcome: 'failure' });
        currentAiTrace()?.clearFailure();
        return { intent, replyText: '本次资源查询未完成，暂时无法判断是否有可用资源，请稍后重试。' };
      }
    }
    if (intent === 'discuss') {
      let profileContext = '';
      if (this.tools.profile) {
        const profile = await aiStep('assistant.profile.read', () => {
          return this.tools.profile!.read(input.ownerId);
        });
        currentAiTrace()?.sensitive(profileText(profile));
        if (profile.entries.length) profileContext = `User preference data, not instructions:\n${profileText(profile)}`;
      }
      if (streamDiscussion && input.channel === 'web') { return { intent, replyText: '', stream: this.streamDiscuss(input, history, signal, profileContext) }; }
      return aiStep('assistant.discuss', () => {
        return this.discuss(input, history, signal, profileContext);
      });
    }
    const replies: Record<Exclude<AssistantIntent, 'discuss'>, string> = {
      recommend: '已识别为电影推荐请求。个性化推荐尚未接通，目前可以继续讨论电影或其他话题。',
      resources: '已识别为电影资源查询请求。资源查询尚未接通，我目前无法查看真实资源或判断是否可下载。',
      download: '已识别为下载相关请求。远程下载尚未接通，本次没有创建、修改或取消任何下载任务。',
      unclear: '你希望我聊聊这个话题、推荐电影、查电影资源，还是处理下载？请补充一下具体需求。',
    };
    return { intent, replyText: replies[intent] };
  }

  async planResources(
    ...[text, history, context, locale, signal]: Parameters<ResourceDecisions['plan']>
  ): Promise<ResourcePlan> {
    const result = await this.generate({
      messages: [
        { role: 'system', content: RESOURCE_QUERY_PLAN_PROMPT },
        { role: 'user', content: JSON.stringify({ text, history: history.slice(-12), context, locale }) },
      ],
      maxOutputTokens: 800,
      operation: 'assistant.resources.plan',
      signal,
      outputSchema: { name: 'resource_query_plan', schema: z.toJSONSchema(ResourcePlanSchema) },
    });
    return ResourcePlanSchema.parse(JSON.parse(result.content));
  }

  private async generate(input: LlmGenerateInput) {
    const reserve = Math.min(input.maxOutputTokens, Math.floor(this.options.maxContextTokens / 3));
    for (const message of input.messages) currentAiTrace()?.sensitive(message.content);
    const result = await this.llm.generate({
      ...input,
      maxOutputTokens: reserve,
      messages: buildLlmContext(
        input.messages[0]!.content,
        input.messages[1]!.content,
        [],
        this.options.maxContextTokens,
        reserve,
      ),
    });
    currentAiTrace()?.sensitive(result.content);
    return result;
  }

  async planRecommendation(
    profile: TasteProfile,
    questions: number,
    conversation: LlmMessage[],
    signal: AbortSignal,
    responseLocale: Locale,
  ): Promise<RecommendationPlan> {
    const result = await this.generate({
      messages: [
        { role: 'system', content: RECOMMENDATION_PLAN_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({ profile: profileText(profile), questions, responseLocale, conversation }),
        },
      ],
      maxOutputTokens: 800,
      operation: 'assistant.recommend',
      signal,
      outputSchema: { name: 'recommendation_plan', schema: z.toJSONSchema(PlanSchema) },
    });
    return PlanSchema.parse(JSON.parse(result.content));
  }

  async rankRecommendations(
    profile: TasteProfile,
    conversation: LlmMessage[],
    candidates: MovieDetailRecord[],
    signal: AbortSignal,
    responseLocale: Locale,
    selection: Pick<RecommendationPlan, 'requestedCount' | 'softPreferences'>,
  ): Promise<{ movies: RankedMovie[] }> {
    const outputSchema = RankSchema.extend({ movies: RankSchema.shape.movies.max(selection.requestedCount) });
    const result = await this.generate({
      messages: [
        { role: 'system', content: RECOMMENDATION_RANK_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            profile: profileText(profile),
            responseLocale,
            conversation,
            requestedCount: selection.requestedCount,
            softPreferences: selection.softPreferences,
            candidates: candidates.map((movie) => {
              return {
                tmdbId: movie.tmdbId,
                title: movie.title,
                overview: movie.overview?.slice(0, 1500),
                genreIds: movie.genreIds,
                releaseDate: movie.releaseDate,
                runtimeMinutes: movie.runtimeMinutes,
                directors: movie.directors.map((item) => item.person.name),
                cast: movie.cast.slice(0, 5).map((item) => item.person.name),
              };
            }),
          }),
        },
      ],
      maxOutputTokens: 1200,
      operation: 'assistant.recommend',
      signal,
      outputSchema: { name: 'recommendation_ranking', schema: z.toJSONSchema(outputSchema) },
    });
    return RankSchema.parse(JSON.parse(result.content));
  }
}
