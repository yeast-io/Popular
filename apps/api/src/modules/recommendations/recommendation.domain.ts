import type { RecommendationState } from './recommendation.types.js';

export const RECOMMENDATION_GENRE_IDS = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37];

export function emptyRecommendationState(): RecommendationState {
  return { questions: 0, active: false, history: [], events: {}, batches: [] };
}
