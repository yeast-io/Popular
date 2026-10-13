import { Types, type Model, type PipelineStage } from 'mongoose';
import type {
  ExternalRequestRecorder, ExternalRequestEventInput, ExternalUsageQueryResult, ExternalUsageReader,
} from '../../modules/external-usage/external-usage.types.js';
import { EXTERNAL_USAGE_RETENTION_DAYS, type ExternalRequestEventDocument } from './external-request-event.schema.js';
import type { ExternalUsageDailyDocument } from './external-usage-daily.schema.js';

export interface ExternalUsageLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export class MongoExternalUsageStore implements ExternalRequestRecorder, ExternalUsageReader {
  constructor(
    private readonly events: Model<ExternalRequestEventDocument>,
    private readonly daily: Model<ExternalUsageDailyDocument>,
    private readonly logger: ExternalUsageLogger,
  ) {}

  async record(input: ExternalRequestEventInput): Promise<void> {
    if ((input.actorType === 'user') !== Boolean(input.ownerId)) {
      this.logger.error({ provider: input.provider, operation: input.operation }, 'Rejected invalid external request attribution');
      return;
    }
    const expiresAt = new Date(input.occurredAt);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + EXTERNAL_USAGE_RETENTION_DAYS);
    try {
      await this.events.create({ ...input, expiresAt });
    } catch (error) {
      if (isDuplicateKey(error)) return;
      this.logger.error({ err: error, provider: input.provider, operation: input.operation }, 'Could not record external request usage');
    }
  }

  async rebuildDaily(since: Date): Promise<void> {
    await this.events.aggregate(dailyAggregationPipeline(since, this.daily.collection.name)).exec();
  }

  async readUserUsage(ownerId: string, from: Date, to: Date): Promise<ExternalUsageQueryResult> {
    const [result] = await this.events.aggregate<ExternalUsageQueryResult>([
      ({ $match: { ownerId: new Types.ObjectId(ownerId), occurredAt: { $gte: from, $lt: to } } }),
      ({ $facet: {
        totals: [metricGroup(null), metricProject()],
        providers: [metricGroup({ provider: '$provider' }), metricProject({ provider: '$_id.provider' })],
        daily: [
          metricGroup({
            date: { $dateToString: { date: '$occurredAt', format: '%Y-%m-%d', timezone: 'UTC' } },
            provider: '$provider',
          }),
          { $project: {
            _id: 0, date: '$_id.date', provider: '$_id.provider',
            requests: 1, successes: 1, failures: 1,
          } },
          { $sort: { date: 1, provider: 1 } },
        ],
        operations: [
          metricGroup({ provider: '$provider', operation: '$operation' }),
          metricProject({ provider: '$_id.provider', operation: '$_id.operation' }),
          { $sort: { requests: -1, provider: 1, operation: 1 } },
        ],
      } }),
      ({ $project: {
        totals: { $ifNull: [{ $arrayElemAt: ['$totals', 0] }, emptyMetrics()] },
        providers: 1,
        daily: 1,
        operations: 1,
      } }),
    ]).exec();
    return result ?? { totals: emptyMetrics(), providers: [], daily: [], operations: [] };
  }
}

function metricGroup(id: unknown): PipelineStage.Group {
  return { $group: {
    _id: id,
    requests: { $sum: 1 },
    successes: { $sum: { $cond: [{ $eq: ['$outcome', 'success'] }, 1, 0] } },
    failures: { $sum: { $cond: [{ $eq: ['$outcome', 'failure'] }, 1, 0] } },
    totalDurationMs: { $sum: '$durationMs' },
  } };
}

function metricProject(extra: Record<string, unknown> = {}): PipelineStage.Project {
  return { $project: {
    _id: 0,
    requests: 1,
    successes: 1,
    failures: 1,
    totalDurationMs: 1,
    ...extra,
  } };
}

function emptyMetrics() {
  return { requests: 0, successes: 0, failures: 0, totalDurationMs: 0 };
}

export function dailyAggregationPipeline(since: Date, targetCollection: string): PipelineStage[] {
  const metrics = {
    successCount: { $sum: { $cond: [{ $eq: ['$outcome', 'success'] }, 1, 0] } },
    failureCount: { $sum: { $cond: [{ $eq: ['$outcome', 'failure'] }, 1, 0] } },
    totalDurationMs: { $sum: '$durationMs' },
    maxDurationMs: { $max: '$durationMs' },
  };
  const bucketDate = { $dateTrunc: { date: '$occurredAt', unit: 'day', timezone: 'UTC' } };
  return [
    { $match: { occurredAt: { $gte: since } } },
    {
      $facet: {
        global: [
          { $group: { _id: { bucketDate, provider: '$provider', operation: '$operation' }, ...metrics } },
          { $project: {
            _id: 0, bucketDate: '$_id.bucketDate', scopeKey: { $literal: 'global' },
            provider: '$_id.provider', operation: '$_id.operation',
            successCount: 1, failureCount: 1, totalDurationMs: 1, maxDurationMs: 1,
          } },
        ],
        users: [
          { $match: { ownerId: { $exists: true } } },
          { $group: { _id: { bucketDate, ownerId: '$ownerId', provider: '$provider', operation: '$operation' }, ...metrics } },
          { $project: {
            _id: 0, bucketDate: '$_id.bucketDate', ownerId: '$_id.ownerId',
            scopeKey: { $concat: ['user:', { $toString: '$_id.ownerId' }] },
            provider: '$_id.provider', operation: '$_id.operation',
            successCount: 1, failureCount: 1, totalDurationMs: 1, maxDurationMs: 1,
          } },
        ],
      },
    },
    { $project: { rows: { $concatArrays: ['$global', '$users'] } } },
    { $unwind: '$rows' },
    { $replaceRoot: { newRoot: '$rows' } },
    { $set: {
      expiresAt: { $dateAdd: { startDate: '$bucketDate', unit: 'day', amount: EXTERNAL_USAGE_RETENTION_DAYS + 1 } },
      updatedAt: '$$NOW',
    } },
    { $merge: {
      into: targetCollection,
      on: ['bucketDate', 'scopeKey', 'provider', 'operation'],
      whenMatched: 'replace',
      whenNotMatched: 'insert',
    } },
  ] as PipelineStage[];
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
