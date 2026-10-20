

import type { LlmMessage } from '../llm/llm.types.js';

import type { messages } from './assistant.presentation.js';

import type { DownloadProvider, Locale, MovieDownload } from '@movie-hub/contract';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import type { AssistantSessionStore } from './assistant-session.types.js';
import type { ResourceQueryCapability } from '../resource-query/resource-query.types.js';
import type { RecommendationMovie } from '../recommendations/recommendation.types.js';
import type { PreferenceService } from '../preferences/preference.service.js';
import type { RecommendationCapability } from '../recommendations/recommendation.types.js';
import type { LlmStreamEvent } from '../llm/llm.types.js';

/** Supported messaging channels, both using the same workflow entry point. */
export type AssistantChannel = 'telegram' | 'whatsapp' | 'web';

/**
 * Normalized text message produced by a channel service, excluding the raw platform payload.
 * Types provide compile-time checks only; validate data and account bindings at runtime.
 */
export interface AssistantInputWorkflowMessage {
  /** System user ID resolved from the channel binding, never supplied by AI or message text. */
  ownerId: string;

  /** Source channel, also used to select the reply transport. */
  channel: AssistantChannel;

  /** Platform chat ID, stored as a string to avoid numeric precision and platform type differences. */
  chatId: string;

  /**
   * Platform message ID used for reply correlation and deduplication.
   * Not globally unique; deduplication must also account for channel, receiving account, and chat.
   * The adapter must provide a stable identifier rather than generate a new random ID on retry.
   */
  messageId: string;

  /** Non-empty text to process; the adapter handles unsupported media messages separately. */
  text: string;

  /** Time the backend first received the message, serialized as ISO 8601 for storage and queues. */
  receivedAt: string;
}

/**
 * discuss: general conversation; recommend: movie recommendations; resources: movie resource lookup;
 * download: download-related requests; unclear: insufficient information requiring clarification.
 * Used for routing only; a download intent does not constitute download confirmation.
 */
export type AssistantIntent = 'discuss' | 'recommend' | 'download' | 'resources' | 'unclear';

/** Reply produced by a successful workflow run; does not imply successful message delivery. */
export interface AssistantWorkflowResult {
  /** Validated routing decision; omitted when the run ends with a user-facing error. */
  intent?: AssistantIntent;
  /** Non-empty reply text; the unclear branch returns a clarification question here. */
  replyText: string;
  /** Structured movies for Telegram/WhatsApp delivery; text remains the history/fallback representation. */
  movies?: RecommendationMovie[];
  /** In-process web stream, never persisted to the inbox or returned in an HTTP JSON response. */
  stream?: AsyncIterable<LlmStreamEvent>;
}

/** Shared entry point for channel services, hiding internal nodes and graph structure. */
export interface AssistantWorkflowContract {
  /**
   * Process one message and return reply content; failures reject the promise for the caller to handle.
   * The caller retains the original input and sends replyText to the corresponding channel and chat.
   * This workflow does not send messages; delivery retries must not repeat business operations.
   */
  run(input: AssistantInputWorkflowMessage): Promise<AssistantWorkflowResult>;
}

export interface AssistantAgentOptions {
  locale?: Locale;
  systemPrompt: string;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface AssistantRequestClassification {
  intent: AssistantIntent;
  handling?: 'answer' | 'tool' | 'clarify';
  preferenceSignal: 'none' | 'explicit' | 'uncertain';
  locale?: Locale;
}

export interface AssistantWorkflowOptions extends AssistantAgentOptions {
  preferences?: PreferenceService;
  resources?: ResourceQueryCapability;
  recommendations?: RecommendationCapability;
  diagnostics?: { logger?: AiLogger; verbose: boolean };
  sessions?: AssistantSessionStore;
  downloads?: {
    providersFor(ownerId: string): Promise<DownloadProvider[]>;
    defaultProviderFor?(ownerId: string): Promise<DownloadProvider | undefined>;
    createForOwner(ownerId: string, tmdbId: number, releaseId: string, provider: DownloadProvider): Promise<MovieDownload>;
  };
  report?: (event: string) => void;
}

export type MessageKey = keyof typeof messages['zh-CN'];

export type AssistantConversation = Pick<AssistantInputWorkflowMessage, 'ownerId' | 'channel' | 'chatId'>;

export interface AssistantJob {
  id: string;
  input: AssistantInputWorkflowMessage;
  attempts: number;
  deliveredMovieCount?: number;
  result?: AssistantWorkflowResult;
}

/** Durable inbox/outbox contract. Completed replies are reused when delivery is retried. */
export interface AssistantQueue {
  enqueue(input: AssistantInputWorkflowMessage): Promise<void>;
  /** Return due conversation heads, including abandoned processing leases. */
  readyConversations(limit: number): Promise<AssistantConversation[]>;
  /** Claim only the oldest unfinished message in this conversation. */
  claim(conversation: AssistantConversation, leaseId: string): Promise<AssistantJob | null>;
  renew(id: string, leaseId: string): Promise<boolean>;
  history(input: AssistantInputWorkflowMessage): Promise<LlmMessage[]>;
  saveResult(id: string, leaseId: string, result: AssistantWorkflowResult): Promise<boolean>;
  markMovieDelivered(id: string, leaseId: string, count: number): Promise<boolean>;
  delivered(id: string, leaseId: string): Promise<void>;
  retry(id: string, leaseId: string, exhausted: boolean): Promise<void>;
}

export interface AssistantWorkerOptions {
  maxConcurrency: number;
  scanIntervalMs: number;
  scanTraceEnabled?: boolean;
  verbose?: boolean;
  setTyping?: (input: AssistantInputWorkflowMessage, active: boolean, signal: AbortSignal) => Promise<void>;
}
