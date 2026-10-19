import { Static, Type } from '@sinclair/typebox';

export const ExternalUsageDaysSchema = Type.Union([Type.Literal(7), Type.Literal(30), Type.Literal(90)]);

export const ExternalUsageQuerySchema = Type.Object(
  {
    days: Type.Optional(ExternalUsageDaysSchema),
  },
  { additionalProperties: false },
);

const ExternalProviderIdSchema = Type.String({
  minLength: 1,
  maxLength: 32,
  pattern: '^[a-z][a-z0-9_-]*$',
});
const DateOnlySchema = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });

const TokenUsageSchema = Type.Object(
  {
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    cachedInputTokens: Type.Integer({ minimum: 0 }),
    knownRequests: Type.Integer({ minimum: 0 }),
    unknownRequests: Type.Integer({ minimum: 0 }),
    unknownCachedRequests: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const usageMetricProperties = {
  requests: Type.Integer({ minimum: 0 }),
  successes: Type.Integer({ minimum: 0 }),
  failures: Type.Integer({ minimum: 0 }),
  averageDurationMs: Type.Integer({ minimum: 0 }),
  tokenUsage: Type.Optional(TokenUsageSchema),
};

const UsageMetricsSchema = Type.Object(usageMetricProperties, { additionalProperties: false });

const ProviderUsageSchema = Type.Object(
  {
    provider: ExternalProviderIdSchema,
    ...usageMetricProperties,
  },
  { additionalProperties: false },
);

const DailyProviderUsageSchema = Type.Object(
  {
    provider: ExternalProviderIdSchema,
    requests: Type.Integer({ minimum: 0 }),
    successes: Type.Integer({ minimum: 0 }),
    failures: Type.Integer({ minimum: 0 }),
    tokenUsage: Type.Optional(TokenUsageSchema),
  },
  { additionalProperties: false },
);

const DailyUsageSchema = Type.Object(
  {
    date: DateOnlySchema,
    providers: Type.Array(DailyProviderUsageSchema),
  },
  { additionalProperties: false },
);

const OperationUsageSchema = Type.Object(
  {
    provider: ExternalProviderIdSchema,
    operation: Type.String({ minLength: 1, maxLength: 80 }),
    ...usageMetricProperties,
  },
  { additionalProperties: false },
);

const ModelUsageSchema = Type.Object(
  {
    provider: ExternalProviderIdSchema,
    model: Type.String({ minLength: 1, maxLength: 128 }),
    operation: Type.String({ minLength: 1, maxLength: 80 }),
    ...usageMetricProperties,
  },
  { additionalProperties: false },
);

export const ExternalUsageResponseSchema = Type.Object(
  {
    range: Type.Object(
      {
        days: ExternalUsageDaysSchema,
        from: DateOnlySchema,
        to: DateOnlySchema,
        timezone: Type.Literal('UTC'),
        retentionDays: Type.Literal(90),
      },
      { additionalProperties: false },
    ),
    totals: UsageMetricsSchema,
    providers: Type.Array(ProviderUsageSchema),
    daily: Type.Array(DailyUsageSchema),
    operations: Type.Array(OperationUsageSchema),
    models: Type.Optional(Type.Array(ModelUsageSchema)),
  },
  { additionalProperties: false },
);

export type ExternalUsageDays = Static<typeof ExternalUsageDaysSchema>;
export type ExternalUsageQuery = Static<typeof ExternalUsageQuerySchema>;
export type ExternalUsageResponse = Static<typeof ExternalUsageResponseSchema>;
