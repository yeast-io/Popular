export interface HDAreaHttpOptions {
  fetch?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}
export interface HDAreaHttpLane {
  tail: Promise<void>;
  pending: number;
  nextAt: number;
  blockedUntil: number;
}
