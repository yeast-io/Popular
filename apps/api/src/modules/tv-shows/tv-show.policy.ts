export const tvShowPolicy = {
  trendingTtlMs: 60 * 60 * 1000,
  detailTtlMs: 24 * 60 * 60 * 1000,
  lockTtlSeconds: 300,
  snapshotRetentionMs: 24 * 60 * 60 * 1000,
  maxPage: 50,
} as const;
