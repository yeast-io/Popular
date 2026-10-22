import type {
  ExternalRequestEventInput,
  ExternalRequestRecorder,
} from '../../modules/external-usage/external-usage.types.js';

export interface OpenAIAccountingOptions {
  ownerId: string;
  recorder: ExternalRequestRecorder;
  maxRetries?: number;
  retryDelayMs?: number;
}

export type RecordedTokenUsage = NonNullable<ExternalRequestEventInput['tokenUsage']>;

export interface OpenAIRequestAttempt {
  finish(
    outcome: 'success' | 'failure',
    usage?: RecordedTokenUsage,
    responseModel?: string,
    error?: unknown,
  ): Promise<void>;
}
