import type { PreferenceService } from '../preferences/preference.service.js';
import type { RecommendationWorkflow } from '../recommendations/recommendation.workflow.js';

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
}

/**
 * Minimal workflow state: input -> intent -> reply.
 * Optional fields indicate pending node output, not permission to skip required nodes.
 * This data contract does not provide persistence, idempotency, or concurrency control.
 */
export interface AssistantWorkflowState {
  input: AssistantInputWorkflowMessage;
  intent?: AssistantIntent;
  replyText?: string;
}

/**
 * Business contracts for internal nodes; the workflow implementation defines their connections.
 * LangGraph nodes can wrap these methods without implementing this interface directly.
 */
export interface AssistantWorkflowNodes {
  /**
   * Detect intent from the message and any context loaded by the implementation.
   * Natural language typically requires an asynchronous AI call.
   * Model failures must throw rather than be classified as unclear.
   */
  detectIntent(input: AssistantInputWorkflowMessage): Promise<AssistantIntent>;

  /** Route using the detected intent; download handling must still enforce confirmation rules. */
  handleIntent(
    input: AssistantInputWorkflowMessage,
    intent: AssistantIntent,
  ): Promise<AssistantWorkflowResult>;
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
  systemPrompt: string;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface AssistantDetection {
  intent: AssistantIntent;
  preferenceSignal: 'none' | 'explicit' | 'uncertain';
}

export interface AssistantWorkflowOptions extends AssistantAgentOptions {
  preferences?: PreferenceService;
  recommendations?: RecommendationWorkflow;
  report?: (event: string) => void;
  deferDiscussion?: boolean;
}
