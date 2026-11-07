import { randomUUID } from 'node:crypto';
import { currentAiTrace } from '../logging/ai-trace.js';
import type { TaskExecutionKind, TaskExecutionOutcome, TaskStatisticEvent, TaskStatistics } from './background-task.types.js';

/** Telemetry never delays execution and never changes a business outcome. */
export function beginTaskStatistics(statistics: TaskStatistics | undefined, name: string, kind: TaskExecutionKind) {
  const trace = currentAiTrace();
  const base = { name, kind, executionId: randomUUID(), startedAt: Date.now() };
  let finished = false;
  const record = (event: TaskStatisticEvent) => {
    if (!statistics) return;
    void Promise.resolve().then(() => statistics.record(event)).catch((error: unknown) => {
      trace?.fail(error, { stage: 'background-task.statistics', task: name });
    });
  };
  record({ ...base, phase: 'started' });
  return (outcome: TaskExecutionOutcome) => {
    if (finished) return;
    finished = true;
    record({ ...base, phase: 'finished', outcome });
  };
}
