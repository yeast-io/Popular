import type { AiProvider } from '@movie-hub/contract';
import type {
  ExternalRequestEventInput,
  ExternalRequestRecorder,
} from '../../modules/external-usage/external-usage.types.js';

export interface LlmAccountingOptions {
  provider?: AiProvider;
  ownerId: string;
  recorder: ExternalRequestRecorder;
  maxRetries?: number;
  retryDelayMs?: number;
}

export type RecordedTokenUsage = NonNullable<ExternalRequestEventInput['tokenUsage']>;

export interface LlmRequestAttempt {
  finish(
    outcome: 'success' | 'failure',
    usage?: RecordedTokenUsage,
    responseModel?: string,
    error?: unknown,
  ): Promise<void>;
}
