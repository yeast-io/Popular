import type { LlmMessage } from '../llm/llm.types.js';
import type { AssistantInputWorkflowMessage, AssistantWorkflowResult } from './assistant.types.js';

export type AssistantConversation = Pick<AssistantInputWorkflowMessage, 'ownerId' | 'channel' | 'chatId'>;

export interface AssistantJob {
  id: string;
  input: AssistantInputWorkflowMessage;
  attempts: number;
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
  delivered(id: string, leaseId: string): Promise<void>;
  retry(id: string, leaseId: string, exhausted: boolean): Promise<void>;
}
