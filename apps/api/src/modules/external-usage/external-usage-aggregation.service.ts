import { EXTERNAL_USAGE_RETENTION_DAYS } from '../../infrastructure/mongodb/external-request-event.schema.js';

export interface ExternalUsageAggregator {
  rebuildDaily(since: Date): Promise<void>;
}

export interface ExternalUsageAggregationLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export class ExternalUsageAggregationService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: ExternalUsageAggregator,
    private readonly logger: ExternalUsageAggregationLogger,
    private readonly intervalMs = 5 * 60 * 1_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return;
    void this.rebuild(retentionStart(this.now()));
    this.timer = setInterval(() => void this.rebuild(recentStart(this.now())), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async rebuild(since: Date): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.store.rebuildDaily(since);
    } catch (error) {
      this.logger.error({ err: error, since }, 'Could not rebuild external usage aggregates');
    } finally {
      this.running = false;
    }
  }
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
