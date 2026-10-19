import type { ExternalUsageDays, ExternalUsageResponse } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import type { ExternalUsageMetricRecord, ExternalUsageReader } from './external-usage.types.js';

export class ExternalUsageService {
  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly usage: ExternalUsageReader,
    private readonly now: () => Date = () => new Date()
  ) {}

  async readMine(token: string | undefined, days: ExternalUsageDays): Promise<ExternalUsageResponse> {
    const ownerId = await this.auth.requireOwnerId(token);
    const today = startOfUtcDay(this.now());
    const from = new Date(today);
    from.setUTCDate(from.getUTCDate() - days + 1);
    const to = new Date(today);
    to.setUTCDate(to.getUTCDate() + 1);
    const result = await this.usage.readUserUsage(ownerId, from, to);
    const dailyByDate = new Map<string, ExternalUsageResponse['daily'][number]['providers']>();
    for (const row of result.daily) {
      const providers = dailyByDate.get(row.date) ?? [];
      providers.push({
        provider: row.provider,
        requests: row.requests,
        successes: row.successes,
        failures: row.failures,
        ...(row.tokenUsage ? { tokenUsage: row.tokenUsage } : {}),
      });
      dailyByDate.set(row.date, providers);
    }
    return {
      range: {
        days,
        from: dateOnly(from),
        to: dateOnly(today),
        timezone: 'UTC',
        retentionDays: 90,
      },
      totals: toMetrics(result.totals),
      providers: result.providers.map((row) => ({ provider: row.provider, ...toMetrics(row) })),
      daily: Array.from({ length: days }, (_, index) => {
        const date = new Date(from);
        date.setUTCDate(date.getUTCDate() + index);
        const value = dateOnly(date);
        return { date: value, providers: dailyByDate.get(value) ?? [] };
      }),
      operations: result.operations.map((row) => {
        return {
          provider: row.provider,
          operation: row.operation,
          ...toMetrics(row),
        };
      }),
      models: (result.models ?? []).map((row) => {
        return { provider: row.provider, model: row.model, operation: row.operation, ...toMetrics(row) };
      }),
    };
  }
}

function toMetrics(value: ExternalUsageMetricRecord) {
  return {
    requests: value.requests,
    successes: value.successes,
    failures: value.failures,
    averageDurationMs: value.requests ? Math.round(value.totalDurationMs / value.requests) : 0,
    ...(value.tokenUsage ? { tokenUsage: value.tokenUsage } : {}),
  };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
