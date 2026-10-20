import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import type { NotificationPreferencesDocument } from './notification-preferences.schema.js';
import type { SaveNotificationPreferences } from '@movie-hub/contract';
import { CHECK_INTERVAL_MS } from '../../../modules/notifications/notification.policy.js';
import type { ClaimedDownload, ClaimedIntent, NotificationPlan, NotificationStore } from '../../../modules/notifications/notification.types.js';
import type { MovieDownloadProgress } from '../../../modules/downloads/movie-download.types.js';
import type { MovieDownloadDocument } from '../downloads/movie-download.schema.js';
import { toMovieDownloadRecord } from '../downloads/movie-download.store.js';

const unlocked = (path: string, now: Date) => {
  return { $or: [{ [`${path}.lockedUntil`]: { $exists: false } }, { [`${path}.lockedUntil`]: { $lte: now } }] };
};
const later = (now: Date) => new Date(now.getTime() + CHECK_INTERVAL_MS);

export class MongoNotificationStore implements NotificationStore {
  constructor(
    private readonly downloads: Model<MovieDownloadDocument>,
    private readonly settings: Model<NotificationPreferencesDocument>
  ) {}
  async preferences(ownerId: string) {
    const row = await this.settings.findOne({ ownerId }).lean().exec();
    return {
      enabled: row?.enabled ?? false,
      defaultChannel: row?.defaultChannel ?? 'whatsapp',
      additionalChannels: row?.additionalChannels ?? [],
      epoch: row?.epoch ?? 0,
    };
  }
  async savePreferences(ownerId: string, input: SaveNotificationPreferences) {
    // Create first so concurrent initial writes cannot reset the cancellation generation.
    try {
      await this.settings.updateOne({ ownerId }, { $setOnInsert: { ownerId } }, { upsert: true }).exec();
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    const row = await this.settings
      .findOneAndUpdate(
        { ownerId },
        {
          $set: input,
          ...(!input.enabled ? { $inc: { epoch: 1 } } : {}),
        },
        { new: true },
      )
      .lean()
      .exec();
    if (!row) throw new Error('Notification preferences disappeared');
    return {
      enabled: row.enabled,
      defaultChannel: row.defaultChannel,
      additionalChannels: row.additionalChannels,
      epoch: row.epoch,
    };
  }
  async cancelOwner(ownerId: string, beforeEpoch: number) {
    await this.downloads
      .updateMany(
        { ownerId, 'notificationTask.epoch': { $lt: beforeEpoch }, 'notificationTask.notified': false },
        {
          $set: { 'notificationTask.cancelled': true },
          $unset: { 'notificationTask.leaseId': 1, 'notificationTask.lockedUntil': 1 },
        },
      )
      .exec();
    await this.downloads
      .updateMany({ ownerId, 'notificationIntent.epoch': { $lt: beforeEpoch } }, { $unset: { notificationIntent: 1 } })
      .exec();
  }
  async reserve(ownerId: string, downloadId: string, plan: NotificationPlan) {
    const result = await this.downloads
      .updateOne(
        { _id: downloadId, ownerId, notificationTask: { $exists: false } },
        { $set: { notificationIntent: plan } },
      )
      .exec();
    if (!result.matchedCount) throw new Error('Download notification reservation lost');
  }
  async activate(ownerId: string, downloadId: string, now: Date, leaseId?: string, progress?: MovieDownloadProgress) {
    const filter = {
      _id: downloadId,
      ownerId,
      notificationTask: { $exists: false },
      ...(leaseId ? { 'notificationIntent.leaseId': leaseId, 'notificationIntent.lockedUntil': { $gt: now } } : {}),
    };
    const row = await this.downloads.findOne(filter).lean().exec();
    const plan = row?.notificationIntent;
    if (!plan) return;
    const preferences = await this.preferences(ownerId);
    if (!preferences.enabled || preferences.epoch !== plan.epoch) {
      await this.downloads
        .updateOne({ ...filter, 'notificationIntent.id': plan.id }, { $unset: { notificationIntent: 1 } })
        .exec();
      return;
    }
    await this.downloads
      .updateOne(
        { ...filter, 'notificationIntent.id': plan.id },
        {
          $set: {
            ...(progress ?? {}),
            notificationTask: {
              id: plan.id,
              epoch: plan.epoch,
              downloaded: false,
              notified: false,
              cancelled: false,
              channels: plan.channels.map((channel) => {
                return { channel, notified: false };
              }),
              nextRunAt: later(now),
            },
          },
          $unset: { notificationIntent: 1 },
        },
      )
      .exec();
    // Cover settings being disabled between the preference read and activation.
    const current = await this.preferences(ownerId);
    if (!current.enabled || current.epoch !== plan.epoch) await this.cancelOwner(ownerId, current.epoch);
  }
  async claimIntent(now: Date): Promise<ClaimedIntent | null> {
    const leaseId = randomUUID();
    const row = await this.downloads
      .findOneAndUpdate(
        {
          'notificationIntent.nextRunAt': { $lte: now },
          notificationTask: { $exists: false },
          ...unlocked('notificationIntent', now),
        },
        { $set: { 'notificationIntent.leaseId': leaseId, 'notificationIntent.lockedUntil': later(now) } },
        { new: true, sort: { 'notificationIntent.nextRunAt': 1 } },
      )
      .lean()
      .exec();
    return row?.notificationIntent
      ? { record: toMovieDownloadRecord(row), plan: row.notificationIntent, leaseId }
      : null;
  }
  async releaseIntent(intent: ClaimedIntent, now: Date, discard: boolean) {
    await this.downloads
      .updateOne(
        {
          _id: intent.record.id,
          ownerId: intent.record.ownerId,
          'notificationIntent.id': intent.plan.id,
          'notificationIntent.leaseId': intent.leaseId,
          'notificationIntent.lockedUntil': { $gt: now },
        },
        discard
          ? { $unset: { notificationIntent: 1 } }
          : {
              $set: { 'notificationIntent.nextRunAt': later(now) },
              $unset: { 'notificationIntent.leaseId': 1, 'notificationIntent.lockedUntil': 1 },
            },
      )
      .exec();
  }
  async claimTask(now: Date): Promise<ClaimedDownload | null> {
    const leaseId = randomUUID();
    const row = await this.downloads
      .findOneAndUpdate(
        {
          'notificationTask.notified': false,
          'notificationTask.cancelled': false,
          'notificationTask.nextRunAt': { $lte: now },
          ...unlocked('notificationTask', now),
        },
        { $set: { 'notificationTask.leaseId': leaseId, 'notificationTask.lockedUntil': later(now) } },
        { new: true, sort: { 'notificationTask.nextRunAt': 1 } },
      )
      .lean()
      .exec();
    const task = row?.notificationTask;
    if (!row || !task) return null;
    return {
      record: toMovieDownloadRecord(row),
      task: {
        id: task.id,
        epoch: task.epoch,
        downloaded: task.downloaded,
        notified: task.notified,
        cancelled: task.cancelled,
        nextRunAt: task.nextRunAt,
        leaseId,
        lockedUntil: later(now),
        channels: task.channels.map((target) => {
          return {
            channel: target.channel,
            notified: target.notified,
            ...(target.messageId ? { messageId: target.messageId } : {}),
          };
        }),
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      },
    };
  }
  private owned(claim: ClaimedDownload, now = new Date()) {
    return {
      _id: claim.record.id,
      ownerId: claim.record.ownerId,
      'notificationTask.id': claim.task.id,
      'notificationTask.leaseId': claim.task.leaseId,
      'notificationTask.lockedUntil': { $gt: now },
      'notificationTask.cancelled': false,
      'notificationTask.notified': false,
    };
  }
  async renew(claim: ClaimedDownload, now: Date) {
    return (
      (
        await this.downloads
          .updateOne(this.owned(claim, now), { $set: { 'notificationTask.lockedUntil': later(now) } })
          .exec()
      ).matchedCount === 1
    );
  }
  async cancel(claim: ClaimedDownload) {
    await this.downloads
      .updateOne(this.owned(claim), {
        $set: { 'notificationTask.cancelled': true },
        $unset: { 'notificationTask.leaseId': 1, 'notificationTask.lockedUntil': 1 },
      })
      .exec();
  }
  async downloaded(claim: ClaimedDownload, progress: MovieDownloadProgress, now: Date) {
    const complete = progress.progress >= 100 && !['failed', 'missing', 'submitting'].includes(progress.status);
    const result = await this.downloads
      .updateOne(this.owned(claim, now), {
        $set: {
          ...progress,
          'notificationTask.lastCheckedAt': now,
          ...(complete ? { 'notificationTask.downloaded': true, 'notificationTask.completedAt': now } : {}),
        },
        $unset: { missingSince: 1, expiresAt: 1, lastErrorCode: 1 },
      })
      .exec();
    if (result.matchedCount && complete) {
      claim.task.downloaded = true;
      claim.task.completedAt = now;
    }
    if (result.matchedCount) Object.assign(claim.record, progress);
    return result.matchedCount === 1;
  }
  async channelNotified(claim: ClaimedDownload, channel: string, messageId: string) {
    const result = await this.downloads
      .updateOne(
        this.owned(claim),
        {
          $set: {
            'notificationTask.channels.$[target].notified': true,
            'notificationTask.channels.$[target].messageId': messageId,
          },
        },
        { arrayFilters: [{ 'target.channel': channel, 'target.notified': false }] },
      )
      .exec();
    if (result.matchedCount) {
      const target = claim.task.channels.find((item) => {
        return item.channel === channel;
      });
      if (target) {
        target.notified = true;
        target.messageId = messageId;
      }
    }
    return result.matchedCount === 1;
  }
  async finish(claim: ClaimedDownload, now: Date, error?: string) {
    await this.downloads
      .updateOne(this.owned(claim, now), {
        $set: {
          'notificationTask.notified':
            claim.task.downloaded &&
            claim.task.channels.length > 0 &&
            claim.task.channels.every((item) => {
              return item.notified;
            }),
          'notificationTask.nextRunAt': later(now),
          ...(error ? { 'notificationTask.lastError': error } : {}),
        },
        $unset: {
          'notificationTask.leaseId': 1,
          'notificationTask.lockedUntil': 1,
          ...(!error ? { 'notificationTask.lastError': 1 } : {}),
        },
      })
      .exec();
  }
}
