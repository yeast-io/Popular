import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';
import { serializeDiagnosticError } from './diagnostic-error.js';

export type AiLogger = Pick<Logger, 'error'> & Partial<Pick<Logger, 'info' | 'debug' | 'warn'>>;
const context = new AsyncLocalStorage<AiTrace>();
export const currentAiTrace = () => context.getStore();
export const withAiTrace = <T>(trace: AiTrace, action: () => T): T => context.run(trace, action);

export class AiTrace {
  private readonly started = Date.now();
  private readonly secrets = new Set<string>();
  private lastStage = 'request';
  private failedStage: string | undefined;
  constructor(
    private readonly logger: AiLogger | undefined,
    private readonly bindings: Record<string, unknown>,
    content: string,
    private readonly operation?: string,
    private readonly eventsEnabled = true
  ) {
    this.sensitive(content);
  }
  sensitive(value: string): void { if (value) this.secrets.add(value); }
  event(stage: string, fields: Record<string, unknown> = {}): void {
    this.lastStage = stage;
    if (this.eventsEnabled) this.logger?.info?.({ ...this.bindings, operation: this.operation ?? 'conversation.turn', stage, elapsedMs: Date.now() - this.started, ...fields }, stage);
  }
  async step<T>(stage: string, action: () => Promise<T>, fields: Record<string, unknown> = {}): Promise<T> {
    const start = Date.now();
    this.event(`${stage}.started`, fields);
    try {
      const result = await action();
      this.event(`${stage}.completed`, { durationMs: Date.now() - start, ...fields });
      return result;
    } catch (error) {
      this.failedStage ??= stage;
      throw error;
    }
  }
  /** Clear a recorded failure after the caller has handled it and continues execution. */
  clearFailure(): void { this.failedStage = undefined; }
  fail(error: unknown, fields: Record<string, unknown> = {}): void {
    this.logger?.error({
      ...this.bindings, operation: this.operation ?? 'conversation.stream', stage: this.failedStage ?? this.lastStage,
      elapsedMs: Date.now() - this.started, ...fields,
      error: serializeDiagnosticError(error, [...this.secrets]),
    }, this.operation ? `${this.operation} failed` : 'AI conversation request failed');
  }
}

export async function aiStep<T>(stage: string, action: () => Promise<T>, fields?: Record<string, unknown>): Promise<T> {
  const trace = currentAiTrace();
  return trace ? trace.step(stage, action, fields) : action();
}
