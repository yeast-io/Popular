import type { assistantText } from './assistant.presentation.js';
import type { AssistantIntent } from './assistant.types.js';

export const ASSISTANT_CLARIFICATIONS: ReadonlyMap<AssistantIntent, Parameters<typeof assistantText>[1]> = new Map([
  ['recommend', 'recommendUnavailable'],
  ['resources', 'resourcesUnavailable'],
  ['download', 'downloadUnavailable'],
]);
