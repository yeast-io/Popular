export const emailVerificationPolicy = {
  ttlSeconds: 86_400,
  dailyLimit: 100,
  maxAttempts: 5,
  claimSeconds: 60,
} as const;
