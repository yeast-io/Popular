

export interface ExternalUsageLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}
