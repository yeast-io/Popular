import type { RecommendationState } from './recommendation.types.js';
import { RECOMMENDATION_POLICY } from './recommendation.policy.js';

export const RECOMMENDATION_GENRE_IDS = [
  28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37,
];

export function emptyRecommendationState(): RecommendationState {
  return { questions: 0, active: false, lastInteractionAt: null, history: [], events: {}, batches: [] };
}

export function isRecommendationActive(state: RecommendationState, now = Date.now()): boolean {
  if (!state.active || typeof state.lastInteractionAt !== 'string') return false;
  const ageMs = now - Date.parse(state.lastInteractionAt);
  // Legacy, malformed, and future timestamps cannot establish a valid continuation window.
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < RECOMMENDATION_POLICY.inactiveAfterMs;
}
