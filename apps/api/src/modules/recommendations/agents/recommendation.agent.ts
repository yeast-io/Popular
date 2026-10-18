import { z } from 'zod';
import type { TasteProfile } from '@movie-hub/contract';
import type { LlmClient, LlmGenerateInput, LlmMessage } from '../../llm/llm.types.js';
import type { MovieDetailRecord } from '../../movies/movie.types.js';
import { buildLlmContext } from '../../llm/llm.context.js';
import { profileText } from '../../preferences/preference.domain.js';
import type { RecommendationPlan, RankedMovie } from '../recommendation.types.js';
import { RECOMMENDATION_PLAN_SYSTEM_PROMPT, RECOMMENDATION_RANK_SYSTEM_PROMPT } from '../../../config/system-prompts/recommendation.prompts.js';

const PlanSchema = z.strictObject({ question: z.string().max(300).nullable(), genres: z.array(z.number().int()).max(5),
  excludeGenres: z.array(z.number().int()).max(5), referenceTitle: z.string().max(150).nullable(),
  maxRuntime: z.number().int().min(1).max(600).nullable(), language: z.string().regex(/^[a-z]{2}$/).nullable(),
  unverifiableRestrictions: z.array(z.string().max(100)).max(5) });
const RankSchema = z.strictObject({ movies: z.array(z.strictObject({ tmdbId: z.number().int().positive(), reason: z.string().min(1).max(220) })).max(5) });

/** Model-only decisions. Candidate retrieval, filtering and persistence stay in the workflow. */
export class RecommendationAgent {
  constructor(
    private readonly llm: Pick<LlmClient, 'generate'>,
    private readonly maxContextTokens = 32_000
  ) {}
  private generate(input: LlmGenerateInput) {
    const reserve = Math.min(input.maxOutputTokens, Math.floor(this.maxContextTokens / 3));
    return this.llm.generate({ ...input, maxOutputTokens: reserve, messages: buildLlmContext(input.messages[0]!.content,
      input.messages[1]!.content, [], this.maxContextTokens, reserve) });
  }

  async plan(profile: TasteProfile, questions: number, immediate: boolean, conversation: LlmMessage[], signal: AbortSignal): Promise<RecommendationPlan> {
    const result = await this.generate({
      messages: [
        { role: 'system', content: RECOMMENDATION_PLAN_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ profile: profileText(profile), questions, immediate, conversation }) },
      ],
      maxOutputTokens: 800,
      operation: 'assistant.recommend',
      signal,
      outputSchema: { name: 'recommendation_plan', schema: z.toJSONSchema(PlanSchema) },
    });
    return PlanSchema.parse(JSON.parse(result.content));
  }

  async rank(profile: TasteProfile, conversation: LlmMessage[], candidates: MovieDetailRecord[], signal: AbortSignal): Promise<{ movies: RankedMovie[] }> {
    const result = await this.generate({
      messages: [
        { role: 'system', content: RECOMMENDATION_RANK_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ profile: profileText(profile), conversation,
          candidates: candidates.map(movie => ({ tmdbId: movie.tmdbId, title: movie.title, overview: movie.overview?.slice(0, 1500),
            genreIds: movie.genreIds, releaseDate: movie.releaseDate, runtimeMinutes: movie.runtimeMinutes,
            directors: movie.directors.map(item => item.person.name), cast: movie.cast.slice(0, 5).map(item => item.person.name) })) }) },
      ],
      maxOutputTokens: 1200,
      operation: 'assistant.recommend',
      signal,
      outputSchema: { name: 'recommendation_ranking', schema: z.toJSONSchema(RankSchema) },
    });
    return RankSchema.parse(JSON.parse(result.content));
  }
}
