import { randomUUID } from 'node:crypto';
import type { WatchlistMediaType } from '@movie-hub/contract';
import type { ResourceNotificationDocument, ResourceNotificationModel } from './resource-notification.schema.js';
import type {
  ResourceNotificationClaim,
  ResourceNotificationEntry,
  ResourceNotificationStore,
} from '../../../modules/resource-notifications/resource-notification.types.js';
import {
  RESOURCE_NOTIFICATION_LEASE_MS,
  RESOURCE_NOTIFICATION_LIMIT,
} from '../../../modules/resource-notifications/resource-notification.policy.js';

export class MongoResourceNotificationStore implements ResourceNotificationStore {
  constructor(private readonly model: ResourceNotificationModel) {}

  async list(ownerId: string): Promise<ResourceNotificationEntry[]> {
    return ((await this.model.findOne({ ownerId }).lean())?.entries ?? []).map((row) => this.entry(row));
  }

  private entry(row: ResourceNotificationDocument['entries'][number]): ResourceNotificationEntry {
    return {
      id: row.id,
      correlationId: row.correlationId,
      attempts: row.attempts,
      mediaType: row.mediaType,
      tmdbId: row.tmdbId,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      nextRunAt: row.nextRunAt,
      lockedUntil: row.lockedUntil,
      ...(row.leaseId ? { leaseId: row.leaseId } : {}),
      ...(row.notifiedAt ? { notifiedAt: row.notifiedAt } : {}),
      ...(row.lastOutcome ? { lastOutcome: row.lastOutcome } : {}),
    };
  }

  async add(ownerId: string, entry: ResourceNotificationEntry): Promise<boolean> {
    try {
      await this.model.updateOne({ ownerId }, { $setOnInsert: { ownerId, entries: [] } }, { upsert: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const result = await this.model.updateOne(
      {
        ownerId,
        entries: { $not: { $elemMatch: { mediaType: entry.mediaType, tmdbId: entry.tmdbId } } },
        $expr: { $lt: [{ $size: '$entries' }, RESOURCE_NOTIFICATION_LIMIT] },
      },
      { $push: { entries: entry } }
    );
    if (result.modifiedCount) return true;
    return (await this.list(ownerId)).some(
      (item) => item.mediaType === entry.mediaType && item.tmdbId === entry.tmdbId
    );
  }

  async remove(ownerId: string, mediaType: WatchlistMediaType, tmdbId: number): Promise<void> {
    await this.model.updateOne({ ownerId }, { $pull: { entries: { mediaType, tmdbId } } });
  }

  async claim(now: Date, nextRunAt: Date): Promise<ResourceNotificationClaim | null> {
    const leaseId = randomUUID();
    const row = await this.model
      .findOneAndUpdate(
        {
          entries: { $elemMatch: { status: 'pending', nextRunAt: { $lte: now }, lockedUntil: { $lte: now } } },
        },
        {
          $inc: { 'entries.$.attempts': 1 },
          $set: {
            'entries.$.leaseId': leaseId,
            'entries.$.lockedUntil': new Date(now.getTime() + RESOURCE_NOTIFICATION_LEASE_MS),
            'entries.$.nextRunAt': nextRunAt,
          },
        },
        { new: true }
      )
      .lean();
    const entry = row?.entries.find((item) => item.leaseId === leaseId);
    return row && entry ? { ownerId: String(row.ownerId), entry: this.entry(entry), leaseId } : null;
  }

  private filter(claim: ResourceNotificationClaim) {
    return { ownerId: claim.ownerId, entries: { $elemMatch: { id: claim.entry.id, leaseId: claim.leaseId } } };
  }

  async renew(claim: ResourceNotificationClaim, now: Date): Promise<boolean> {
    const result = await this.model.updateOne(
      {
        ownerId: claim.ownerId,
        entries: {
          $elemMatch: {
            id: claim.entry.id,
            leaseId: claim.leaseId,
            lockedUntil: { $gt: now },
          },
        },
      },
      { $set: { 'entries.$.lockedUntil': new Date(now.getTime() + RESOURCE_NOTIFICATION_LEASE_MS) } }
    );
    return result.matchedCount > 0;
  }

  async markNotified(claim: ResourceNotificationClaim, now: Date): Promise<boolean> {
    const result = await this.model.updateOne(this.filter(claim), {
      $set: {
        'entries.$.status': 'notified',
        'entries.$.notifiedAt': now,
        'entries.$.lastOutcome': 'notified',
      },
    });
    return result.matchedCount > 0;
  }

  async finish(
    claim: ResourceNotificationClaim,
    outcome: ResourceNotificationEntry['lastOutcome'] & string
  ): Promise<void> {
    await this.model.updateOne(this.filter(claim), {
      $set: { 'entries.$.lastOutcome': outcome, 'entries.$.lockedUntil': new Date(0) },
      $unset: { 'entries.$.leaseId': 1 },
    });
  }
}
