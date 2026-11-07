import { currentAiTrace } from '../logging/ai-trace.js';
import type { TaskLeaseOptions } from './background-task.types.js';

/** Owns process-local renewal and cancellation; storage retains token fencing and retry policy. */
export class TaskLease {
  private readonly controller: AbortController;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private renewal: Promise<boolean> | undefined;
  private active = false;
  private readonly abortParent = () => this.controller.abort(this.options.signal?.reason);
  private readonly clearOnAbort = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  };

  constructor(private readonly options: TaskLeaseOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1 || options.intervalMs > 2_147_483_647)
      throw new Error('Invalid task lease interval');
    this.controller = options.controller ?? new AbortController();
    this.controller.signal.addEventListener('abort', this.clearOnAbort, { once: true });
    options.signal?.addEventListener('abort', this.abortParent, { once: true });
    if (options.signal?.aborted) this.abortParent();
  }

  get signal(): AbortSignal { return this.controller.signal; }

  start(): void {
    if (this.active || this.signal.aborted) return;
    this.active = true;
    this.schedule();
  }

  /** Checkpoints join an in-flight heartbeat instead of racing another renewal. */
  renew(): Promise<boolean> {
    if (this.signal.aborted) return Promise.resolve(false);
    if (this.renewal) return this.renewal;
    this.renewal = Promise.resolve().then(() => this.options.renew()).then((owned) => {
      if (!owned) throw new Error('Task lease lost');
      return !this.signal.aborted;
    }).catch((error: unknown) => {
      if (this.signal.aborted && error === this.signal.reason) return false;
      this.controller.abort(new Error('Task lease renewal failed', { cause: error }));
      try {
        if (this.options.onError) this.options.onError(error);
        else currentAiTrace()?.fail(error, { stage: 'background-task.lease.renew' });
      } catch (reportError) {
        currentAiTrace()?.fail(reportError, { stage: 'background-task.lease.report' });
      }
      return false;
    }).finally(() => {
      this.renewal = undefined;
    });
    return this.renewal;
  }

  async waitForRenewal(): Promise<void> { await this.renewal; }

  /** Cancellation is cooperative: a deadline aborts work but still awaits its settlement. */
  async withDeadline<T>(timeoutMs: number, action: () => Promise<T>): Promise<T> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      throw new Error('Invalid task deadline');
    const deadline = setTimeout(() => this.controller.abort(new Error('Task deadline exceeded')), timeoutMs);
    deadline.unref();
    try {
      this.signal.throwIfAborted();
      const result = await action();
      this.signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(deadline);
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    this.controller.abort();
    this.clearOnAbort();
    this.options.signal?.removeEventListener('abort', this.abortParent);
    this.signal.removeEventListener('abort', this.clearOnAbort);
    await this.waitForRenewal();
  }

  private schedule(): void {
    if (!this.active || this.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.renew().finally(() => this.schedule());
    }, this.options.intervalMs);
    this.timer.unref();
  }
}
