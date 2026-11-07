import type { TaskStatistics } from '../../infrastructure/background-tasks/background-task.types.js';
import { TaskRunner } from '../../infrastructure/background-tasks/task-runner.worker.js';
import type { ExternalUsageAggregator, ExternalUsageAggregationLogger } from './external-usage-aggregation.types.js';
import { EXTERNAL_USAGE_RETENTION_DAYS } from '../../infrastructure/mongodb/external-usage/external-request-event.schema.js';

export class ExternalUsageAggregationService {
  private readonly runner: TaskRunner;

  constructor(
    store: ExternalUsageAggregator,
    logger: ExternalUsageAggregationLogger,
    intervalMs = 5 * 60 * 1_000,
    now: () => Date = () => new Date(),
    scanTraceEnabled = false,
    statistics?: TaskStatistics
  ) {
    this.runner = new TaskRunner({
      statistics,
      name: 'external-usage-aggregation', intervalMs, verbose: scanTraceEnabled,
      logger: {
        error: (fields: unknown, message?: string) => logger.error(fields as Record<string, unknown>, message ?? ''),
        info: (fields: unknown, message?: string) => logger.info?.(fields as Record<string, unknown>, message ?? ''),
      },
      run: async ({ trigger }) => {
        const since = trigger === 'startup' ? retentionStart(now()) : recentStart(now());
        await store.rebuildDaily(since);
      },
    });
  }

  start(): void { this.runner.start(); }

  stop(): Promise<void> { return this.runner.stop(); }
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function retentionStart(now: Date): Date {
  const value = startOfUtcDay(now);
  value.setUTCDate(value.getUTCDate() - EXTERNAL_USAGE_RETENTION_DAYS);
  return value;
}

function recentStart(now: Date): Date {
  const value = startOfUtcDay(now);
  value.setUTCDate(value.getUTCDate() - 1);
  return value;
}
