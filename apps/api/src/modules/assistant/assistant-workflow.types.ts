import type { Locale } from '@movie-hub/contract';
import type { AssistantAgent } from './agents/assistant.agent.js';
import type { LlmMessage } from '../llm/llm.types.js';
import type { AssistantSession } from './assistant-session.types.js';
import type { AssistantInputWorkflowMessage } from './assistant.types.js';

export type AssistantDownloadAction = Awaited<ReturnType<AssistantAgent['planDownload']>>;

export interface AssistantWorkflowTurn {
  locale: Locale;
  input: AssistantInputWorkflowMessage;
  conversation: string;
  eventId: string;
  session: AssistantSession;
  save: () => Promise<void>;
  agent: AssistantAgent;
  history: LlmMessage[];
  signal: AbortSignal;
}
