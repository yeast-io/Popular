/** Shared workflow limits; prompts describe the same policy enforced by code. */
export const RECOMMENDATION_POLICY = {
  maxClarificationQuestions: 3,
  executionTimeoutMs: 180_000,
  inactiveAfterMs: 30 * 60_000,
  initialHistoryMessages: 6,
  historyMessages: 12,
  likedSeedMovies: 2,
  discoveryPages: 2,
  recentBatches: 3,
  detailCandidates: 12,
  retainedBatches: 20,
  retainedEvents: 50,
  maxRecommendations: 5,
} as const;
