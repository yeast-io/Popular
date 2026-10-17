import type { SaveNotificationPreferences } from '@movie-hub/contract';
import type { MovieDownloadProgress, MovieDownloadRecord } from '../downloads/movie-download.types.js';
export interface NotificationPreferenceRecord extends SaveNotificationPreferences { epoch: number }
export interface NotificationPlan { id: string; epoch: number; channels: string[]; nextRunAt: Date }
export interface DownloadNotification {
  id: string; title: string; resourceName: string; provider: string; totalBytes: number;
  completedAt: Date; detailUrl: string; poster?: Buffer;
}
export interface NotificationChannel {
  id: string; name: string;
  isConfigured(ownerId: string): Promise<boolean>;
  send(ownerId: string, notification: DownloadNotification): Promise<{ messageId: string }>;
}
export interface ScanTask {
  id: string; epoch: number; downloaded: boolean; notified: boolean; cancelled: boolean;
  channels: Array<{ channel: string; notified: boolean; messageId?: string }>;
  nextRunAt: Date; leaseId: string; lockedUntil: Date; completedAt?: Date;
}
export interface ClaimedDownload { record: MovieDownloadRecord; task: ScanTask }
export interface ClaimedIntent { record: MovieDownloadRecord; plan: NotificationPlan; leaseId: string }
export interface NotificationStore {
  preferences(ownerId: string): Promise<NotificationPreferenceRecord>;
  savePreferences(ownerId: string, input: SaveNotificationPreferences): Promise<NotificationPreferenceRecord>;
  cancelOwner(ownerId: string, beforeEpoch: number): Promise<void>;
  reserve(ownerId: string, downloadId: string, plan: NotificationPlan): Promise<void>;
  activate(ownerId: string, downloadId: string, now: Date, leaseId?: string, progress?: MovieDownloadProgress): Promise<void>;
  claimIntent(now: Date): Promise<ClaimedIntent | null>;
  releaseIntent(intent: ClaimedIntent, now: Date, discard: boolean): Promise<void>;
  claimTask(now: Date): Promise<ClaimedDownload | null>;
  renew(claim: ClaimedDownload, now: Date): Promise<boolean>;
  cancel(claim: ClaimedDownload): Promise<void>;
  downloaded(claim: ClaimedDownload, progress: MovieDownloadProgress, now: Date): Promise<boolean>;
  channelNotified(claim: ClaimedDownload, channel: string, messageId: string): Promise<boolean>;
  finish(claim: ClaimedDownload, now: Date, error?: string): Promise<void>;
}
export const CHECK_INTERVAL_MS = 120_000;
