export interface SearchRetryOptions {
  signal?: AbortSignal;
  minimumIntervalMs?: number;
  /** Injectable clock/wait only for deterministic policy tests. */
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  budgetMs?: number;
}
