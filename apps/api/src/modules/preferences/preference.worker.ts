import { randomUUID } from 'node:crypto';
import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';
import { serializeDiagnosticError } from '../../infrastructure/logging/diagnostic-error.js';
import type { PreferenceStore } from './preference.types.js';
import type { PreferenceWorkflow } from './preference.workflow.js';

/** Consume durable jobs; own polling, leases, deadlines and retry transitions. */
export class PreferenceWorker {
  private stopped = true;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;

  constructor(
    private readonly store: PreferenceStore,
    private readonly workflow: Pick<PreferenceWorkflow, 'run'>,
    private readonly logger: AiLogger,
    private readonly verbose = false
  ) {}

  start() {
    this.stopped = false;
    this.schedule();
  }

  private schedule() {
    if (this.stopped) return;
    this.running = this.tick()
      .catch((error) => {
        return this.logger.error(
          { event: 'preference_worker_failed', stage: 'preference.task.claim', error: serializeDiagnosticError(error) },
          'Preference worker failed'
        );
      })
      .finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(() => this.schedule(), 2000);
          this.timer.unref();
        }
      });
  }

  async tick() {
    const job = await this.store.claim(randomUUID());
    if (!job) return;
    const trace = new AiTrace(
      this.logger,
      {
        correlationId: job.correlationId ?? job.id,
        event: 'preference_task',
        jobId: job.id,
        ownerId: job.ownerId,
        kind: job.kind,
        attempt: job.attempts,
      },
      '',
      'preference.update',
      this.verbose
    );
    for (const item of job.evidence) trace.sensitive(item.text);
    await withAiTrace(trace, async () => {
      trace.event('preference.task.claimed');
      const controller = new AbortController();
      const deadline = setTimeout(
        () => controller.abort(new Error('Preference task exceeded 150 second deadline')),
        150_000
      );
      const heartbeat = setInterval(() => {
        void this.store
          .renew(job)
          .then((owned) => {
            if (!owned) controller.abort(new Error('Preference task lease lost'));
          })
          .catch((error) => {
            return controller.abort(new Error('Preference task lease renewal failed', { cause: error }));
          });
      }, 30_000
      );
      deadline.unref();
      heartbeat.unref();
      try {
        if (await trace.step('preference.workflow.run', () => this.workflow.run(job, controller.signal))) {
          await trace.step('preference.task.complete', () => this.store.finish(job));
          trace.event('preference.task.completed', { outcome: 'success' });
        }
      } catch (error) {
        // Report the original failure before attempting storage, which may fail independently.
        trace.fail(error, { event: 'preference_task_failed', willRetry: job.attempts < 3 });
        try {
          await this.store.finish(job, 'Preference update failed; check model configuration or retry.');
        } catch (finishError) {
          trace.fail(finishError, {
            event: 'preference_task_failed',
            stage: 'preference.task.record_failure',
            willRetry: job.attempts < 3,
          }
          );
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(deadline);
        controller.abort();
      }
    });
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
