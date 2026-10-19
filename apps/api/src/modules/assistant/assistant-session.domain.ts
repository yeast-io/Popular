import type { AssistantSession } from './assistant-session.types.js';

export const ASSISTANT_SESSION_MS = 30 * 60_000;

export const emptyAssistantSession = (): AssistantSession => ({ updatedAt: '', stage: 'idle', events: [] });
