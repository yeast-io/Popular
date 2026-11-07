import { beginTaskStatistics } from './task-statistics.adapter.js';
import { randomUUID } from 'node:crypto';
import { AiTrace, withAiTrace } from '../logging/ai-trace.js';
import type { BackgroundTaskContext, TaskRunnerOptions } from './background-task.types.js';

/** Process-local execution only. Durable claims, leases and retries belong to the caller.
 * tick() permits one-off execution before start(); after stop(), start() must reopen the runner.
 * start() during an unfinished stop is ignored. Cancellation is cooperative: stop waits for settlement.
 */
export class TaskRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private enabled = false;
  private stopped = false;
  private pendingWake = false;

  constructor(private readonly options: TaskRunnerOptions) {
    if (!options.name.trim() || !Number.isInteger(options.intervalMs) || options.intervalMs < 1
      || options.intervalMs > 2_147_483_647) throw new Error('Invalid background task configuration');
  }

  start(): void {
    if (this.enabled || this.closing) return;
    this.enabled = true;
    this.stopped = false;
    if (this.options.cadence !== 'fixed-delay') {
      this.timer = setInterval(() => void this.execute('timer'), this.options.intervalMs);
      this.timer.unref();
    }
    if (this.options.runOnStart !== false) void this.execute('startup');
    else if (this.options.cadence === 'fixed-delay') this.schedule();
  }

  tick(): Promise<void> { return this.execute('manual'); }

  /** Wakeups coalesce into at most one follow-up run; busy timer ticks never queue work. */
  wake(): void {
    if (this.stopped || this.closing) return;
    if (this.running) this.pendingWake = true;
    else void this.execute('wake');
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.enabled = false;
    this.pendingWake = false;
    this.clearTimer();
    this.controller?.abort();
    this.closing = (this.running ?? Promise.resolve()).finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  private execute(trigger: BackgroundTaskContext['trigger']): Promise<void> {
    if (this.stopped || this.closing) return Promise.resolve();
    if (this.running) return this.running;
    if (this.options.cadence === 'fixed-delay') this.clearTimer();
    const controller = new AbortController();
    this.controller = controller;
    let settle!: () => void;
    const running = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.running = running;
    const finish = () => {
      this.running = undefined;
      this.controller = undefined;
      settle();
      if (this.stopped) return;
      if (this.pendingWake) {
        this.pendingWake = false;
        void this.execute('wake');
      } else if (this.enabled && this.options.cadence === 'fixed-delay') this.schedule();
    };
    // Install running before calling user code, including code that synchronously wakes or stops us.
    void this.perform({ signal: controller.signal, trigger }).then(finish, finish);
    return running;
  }

  private async perform(context: BackgroundTaskContext): Promise<void> {
    const executionId = randomUUID();
    const trace = new AiTrace(this.options.logger,
      { task: this.options.name, executionId, correlationId: executionId, trigger: context.trigger },
      '', 'background-task', this.options.verbose === true);
    await withAiTrace(trace, async () => {
      const started = Date.now();
      const finishStatistics = beginTaskStatistics(this.options.statistics, this.options.name, 'poll');
      let outcome: 'success' | 'failure' | 'cancelled' = 'success';
      try {
        await trace.step('background-task.run', () => this.options.run(context));
        outcome = context.signal.aborted ? 'cancelled' : 'success';
        trace.event('background-task.finished', {
          durationMs: Date.now() - started, outcome: context.signal.aborted ? 'cancelled' : 'success',
        });
      } catch (error) {
        // Stopping does not hide unrelated failures: only the signal's own rejection is cancellation.
        if (context.signal.aborted && error === context.signal.reason) {
          outcome = 'cancelled';
          trace.event('background-task.cancelled', { durationMs: Date.now() - started });
          return;
        }
        outcome = 'failure';
        trace.fail(error, { durationMs: Date.now() - started, outcome: 'failure' });
        try {
          await this.options.onError?.(error);
        } catch (reportError) {
          trace.fail(reportError, { stage: 'background-task.report', outcome: 'failure' });
        }
      } finally {
        finishStatistics(outcome);
      }
    });
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.execute('timer');
    }, this.options.intervalMs);
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      if (this.options.cadence === 'fixed-delay') clearTimeout(this.timer);
      else clearInterval(this.timer);
    }
    this.timer = undefined;
  }
}
