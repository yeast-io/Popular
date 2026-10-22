export interface ExternalUsageAggregator {
  rebuildDaily(since: Date): Promise<void>;
}

export interface ExternalUsageAggregationLogger {
  info?(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}
