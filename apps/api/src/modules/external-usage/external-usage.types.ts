export const EXTERNAL_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const EXTERNAL_PROVIDER_ID_MAX_LENGTH = 32;

export type ExternalProviderId = string;
export type ExternalActorType = 'user' | 'anonymous' | 'system';
export type ExternalRequestTrigger =
  | 'api_request'
  | 'scheduled_sync'
  | 'background_check'
  | 'manual_refresh'
  | 'retry';

export type ExternalRequestErrorCode =
  | 'authentication'
  | 'permission'
  | 'network'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_response'
  | 'remote_error'
  | 'internal_error';

export interface ExternalRequestContext {
  actorType: ExternalActorType;
  ownerId?: string;
  trigger: ExternalRequestTrigger;
}

export interface ExternalRequestEventInput extends ExternalRequestContext {
  provider: ExternalProviderId;
  operation: string;
  outcome: 'success' | 'failure';
  operationId: string;
  attempt: number;
  durationMs: number;
  occurredAt: Date;
  httpStatus?: number;
  errorCode?: ExternalRequestErrorCode;
  /** Model metadata only; never include prompts, outputs, or API credentials. */
  model?: string;
  /** Absent when the provider did not return trustworthy usage. Cached tokens are part of input tokens. */
  tokenUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}

export interface ExternalRequestRecorder {
  record(input: ExternalRequestEventInput): Promise<void>;
}

export interface ExternalUsageMetricRecord {
  requests: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  tokenUsage?: TokenUsageMetrics;
}

export interface TokenUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  knownRequests: number;
  unknownRequests: number;
  unknownCachedRequests: number;
}

export interface ExternalUsageQueryResult {
  totals: ExternalUsageMetricRecord;
  providers: Array<ExternalUsageMetricRecord & { provider: string }>;
  daily: Array<Omit<ExternalUsageMetricRecord, 'totalDurationMs'> & { date: string; provider: string }>;
  operations: Array<ExternalUsageMetricRecord & { provider: string; operation: string }>;
  models?: Array<ExternalUsageMetricRecord & { provider: string; model: string; operation: string }>;
}

export interface ExternalUsageReader {
  readUserUsage(ownerId: string, from: Date, to: Date): Promise<ExternalUsageQueryResult>;
}

export const systemExternalRequestContext = (
  trigger: ExternalRequestTrigger,
): ExternalRequestContext => ({ actorType: 'system', trigger });

export const userExternalRequestContext = (
  ownerId: string | null,
  trigger: ExternalRequestTrigger,
): ExternalRequestContext => ownerId
  ? { actorType: 'user', ownerId, trigger }
  : { actorType: 'anonymous', trigger };
