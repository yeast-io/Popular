import type { ExternalUsageResponse } from '@movie-hub/contract';

export type TokenUsage = NonNullable<ExternalUsageResponse['totals']['tokenUsage']>;
