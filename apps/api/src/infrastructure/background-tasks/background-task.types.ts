import type { AiLogger } from '../logging/ai-trace.types.js';

export interface BackgroundTaskContext {
  signal: AbortSignal;
  trigger: 'startup' | 'timer' | 'manual' | 'wake';
}

export interface TaskRunnerOptions {
  name: string;
  statistics?: TaskStatistics | undefined;
  intervalMs: number;
  /** Fixed rate skips busy timer ticks; fixed delay waits after execution settles. */
  cadence?: 'fixed-rate' | 'fixed-delay';
  runOnStart?: boolean;
  run(context: BackgroundTaskContext): Promise<void>;
  logger?: AiLogger | undefined;
  /** Must be resolved from VERBOSE and any narrower trace switch by the caller. */
  verbose?: boolean;
  onError?(error: unknown): void | Promise<void>;
}

export interface TaskLeaseOptions {
  intervalMs: number;
  renew(): Promise<boolean>;
  controller?: AbortController;
  signal?: AbortSignal;
  onError?(error: unknown): void;
}

export type TaskExecutionOutcome = 'success' | 'failure' | 'cancelled';
export type TaskExecutionKind = 'poll' | 'job';
export interface TaskStatisticEvent {
  name: string;
  kind: TaskExecutionKind;
  executionId: string;
  startedAt: number;
  phase: 'started' | 'finished';
  outcome?: TaskExecutionOutcome;
}
export interface TaskStatistics {
  record(event: TaskStatisticEvent): Promise<void>;
}
