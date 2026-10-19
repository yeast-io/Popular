import { randomUUID } from 'node:crypto';
import { currentAiTrace } from '../../logging/ai-trace.js';
import type { TasteProfile } from '@movie-hub/contract';
import { emptyProfile } from '../../../modules/preferences/preference.domain.js';
import type {
  PreferenceEvidence,
  PreferenceJob,
  PreferenceStore,
} from '../../../modules/preferences/preference.types.js';
import type { createPreferenceModels } from './preference.schema.js';

export class MongoPreferenceStore implements PreferenceStore {
  constructor(
    readonly models: ReturnType<typeof createPreferenceModels>
  ) {}
  async read(ownerId: string): Promise<TasteProfile> {
    const row = await this.models.profiles.findOne({ ownerId }).lean().exec();
    return row ? (row.data as TasteProfile) : emptyProfile();
  }
  async ensure(ownerId: string): Promise<void> {
    try {
      await this.models.profiles
        .updateOne({ ownerId }, { $setOnInsert: { data: emptyProfile(), version: 0 } }, { upsert: true })
        .exec();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  async save(ownerId: string, expected: number, profile: TasteProfile, jobId?: string): Promise<boolean> {
    await this.ensure(ownerId);
    const result = await this.models.profiles
      .updateOne(
        { ownerId, version: expected, ...(jobId ? { appliedJobs: { $ne: jobId } } : {}) },
        { $set: { data: profile, version: profile.version }, ...(jobId ? { $addToSet: { appliedJobs: jobId } } : {}) },
      )
      .exec();
    return result.modifiedCount === 1;
  }
  async applied(ownerId: string, jobId: string): Promise<boolean> {
    return Boolean(await this.models.profiles.exists({ ownerId, appliedJobs: jobId }));
  }
  async enqueue(
    ownerId: string,
    key: string,
    kind: 'manual' | 'chat',
    evidence: PreferenceEvidence[],
    fingerprint: string | null = null,
  ): Promise<void> {
    try {
      await this.models.jobs
        .updateOne(
          { key: `${ownerId}:${key}` },
          {
            $setOnInsert: {
              ownerId,
              kind,
              evidence,
              fingerprint,
              correlationId: currentAiTrace()?.correlationId ?? randomUUID(),
              status: 'pending',
              ...(kind === 'manual' ? { activeOwner: ownerId } : {}),
            },
          },
          { upsert: true },
        )
        .exec();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  async latest(ownerId: string) {
    const row =
      (await this.models.jobs
        .findOne({ ownerId, status: { $in: ['pending', 'processing'] } })
        .sort({ createdAt: -1 })
        .lean()
        .exec()) ?? (await this.models.jobs.findOne({ ownerId }).sort({ createdAt: -1 }).lean().exec());
    return row
      ? {
          status: row.status as 'pending' | 'processing' | 'completed' | 'failed',
          error: row.error ?? null,
          updatedAt: row.updatedAt.toISOString(),
        }
      : null;
  }
  async claim(leaseId: string): Promise<PreferenceJob | null> {
    const now = new Date();
    await this.models.jobs
      .updateMany(
        { status: 'processing', leaseUntil: { $lte: now }, attempts: { $gte: 3 } },
        {
          $set: { status: 'failed', error: 'Preference task exceeded recovery attempts' },
          $unset: { activeOwner: 1 },
        },
      )
      .exec();
    const row = await this.models.jobs
      .findOneAndUpdate(
        {
          $or: [
            { status: 'pending', nextAt: { $lte: now } },
            { status: 'processing', leaseUntil: { $lte: now } },
          ],
        },
        { $set: { status: 'processing', leaseId, leaseUntil: new Date(Date.now() + 180_000) }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      )
      .lean()
      .exec();
    return row
      ? {
          id: String(row._id),
          ownerId: row.ownerId,
          kind: row.kind as 'manual' | 'chat',
          evidence: row.evidence as PreferenceEvidence[],
          fingerprint: row.fingerprint ?? null,
          attempts: row.attempts,
          leaseId,
          ...(row.correlationId ? { correlationId: row.correlationId } : {}),
        }
      : null;
  }
  async finish(job: PreferenceJob, error?: string): Promise<void> {
    await this.models.jobs
      .updateOne(
        { _id: job.id, ownerId: job.ownerId, leaseId: job.leaseId, status: 'processing' },
        {
          $set: {
            status: error ? (job.attempts >= 3 ? 'failed' : 'pending') : 'completed',
            error: error ?? null,
            nextAt: new Date(Date.now() + 30_000 * job.attempts),
            leaseUntil: null,
          },
          ...(!error || job.attempts >= 3 ? { $unset: { activeOwner: 1 } } : {}),
        },
      )
      .exec();
  }
  async owns(job: PreferenceJob): Promise<boolean> {
    return Boolean(
      await this.models.jobs.exists({
        _id: job.id,
        ownerId: job.ownerId,
        leaseId: job.leaseId,
        status: 'processing',
        leaseUntil: { $gt: new Date() },
      }),
    );
  }
  async renew(job: PreferenceJob): Promise<boolean> {
    const result = await this.models.jobs
      .updateOne(
        { _id: job.id, ownerId: job.ownerId, leaseId: job.leaseId, status: 'processing' },
        { $set: { leaseUntil: new Date(Date.now() + 180_000) } },
      )
      .exec();
    return result.matchedCount === 1;
  }
  async cancel(ownerId: string) {
    await this.models.jobs
      .updateMany(
        { ownerId, status: { $in: ['pending', 'processing'] } },
        { $set: { status: 'completed', leaseUntil: null, leaseId: null }, $unset: { activeOwner: 1 } },
      )
      .exec();
  }
}
