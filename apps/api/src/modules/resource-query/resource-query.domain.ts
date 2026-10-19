import type { ResourceQueryState } from './resource-query.types.js';

export const RESOURCE_SESSION_MS = 30 * 60_000;

export function emptyResourceState(): ResourceQueryState {
  return { updatedAt: '', candidates: [], movie: null, resolution: null, providers: [], releases: [], events: [] };
}
