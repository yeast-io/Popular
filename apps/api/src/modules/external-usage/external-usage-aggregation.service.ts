import { EXTERNAL_USAGE_RETENTION_DAYS } from '../../infrastructure/mongodb/external-usage/external-request-event.schema.js';

export interface ExternalUsageAggregator {
  rebuildDaily(since: Date): Promise<void>;
}

export interface ExternalUsageAggregationLogger {
  info?(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export class ExternalUsageAggregationService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly store: ExternalUsageAggregator,
    private readonly logger: ExternalUsageAggregationLogger,
    private readonly intervalMs = 5 * 60 * 1_000,
    private readonly now: () => Date = () => new Date(),
    private readonly scanTraceEnabled = false
  ) {}

  start(): void {
    if (this.timer) return;
    void this.rebuild(retentionStart(this.now()));
    this.timer = setInterval(() => void this.rebuild(recentStart(this.now())), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private rebuild(since: Date): Promise<void> {
    if (this.running) return this.running;
    const started = Date.now();
    if (this.scanTraceEnabled) this.logger.info?.({ event: 'external_usage_scan_started', since }, 'External usage aggregation started');
    this.running = this.store.rebuildDaily(since).then(() => {
      if (this.scanTraceEnabled) this.logger.info?.({ event: 'external_usage_scan_completed', since, durationMs: Date.now() - started }, 'External usage aggregation completed');
    }).catch(error => {
      this.logger.error({ err: error, since }, 'Could not rebuild external usage aggregates');
    }).finally(() => { this.running = undefined; });
    return this.running;
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
