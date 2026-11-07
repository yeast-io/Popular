export interface ResourceSiteHttpOptions {
  fetch?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}
export interface ResourceSiteHttpLane {
  tail: Promise<void>;
  pending: number;
  nextAt: number;
  blockedUntil: number;
}
