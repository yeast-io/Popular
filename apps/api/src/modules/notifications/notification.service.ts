import { randomUUID } from 'node:crypto';
import type { NotificationPreferences, SaveNotificationPreferences } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import { CHECK_INTERVAL_MS, type NotificationChannel, type NotificationPlan, type NotificationStore } from './notification.types.js';

export class NotificationService {
  private readonly channels: Map<string, NotificationChannel>;
  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    readonly store: NotificationStore,
    channels: NotificationChannel[],
    private readonly now: () => Date = () => new Date()
  ) {
    this.channels = new Map(channels.map(channel => [channel.id, channel]));
  }
  channel(id: string): NotificationChannel | undefined { return this.channels.get(id); }
  async listChannels(ownerId: string): Promise<NotificationPreferences['channels']> {
    return Promise.all([...this.channels.values()].map(async channel => ({ id: channel.id, name: channel.name, configured: await channel.isConfigured(ownerId) })));
  }
  async get(token: string | undefined): Promise<NotificationPreferences> {
    return this.response(await this.auth.requireOwnerId(token));
  }
  private async response(ownerId: string): Promise<NotificationPreferences> {
    const preferences = await this.store.preferences(ownerId);
    return { enabled: preferences.enabled, defaultChannel: preferences.defaultChannel, additionalChannels: preferences.additionalChannels,
      channels: await this.listChannels(ownerId) };
  }
  async save(token: string | undefined, input: SaveNotificationPreferences): Promise<NotificationPreferences> {
    const ownerId = await this.auth.requireOwnerId(token);
    const selected = [...new Set([input.defaultChannel, ...input.additionalChannels])];
    for (const id of selected) {
      const channel = this.channels.get(id);
      if (!channel) throw new AppError(400, 'VALIDATION_ERROR', 'Unsupported notification channel');
      if (input.enabled && !await channel.isConfigured(ownerId)) throw new AppError(409, 'CONFLICT', 'Link the selected notification channels first');
    }
    const saved = await this.store.savePreferences(ownerId, { ...input, additionalChannels: [...new Set(input.additionalChannels)].filter(id => id !== input.defaultChannel) });
    if (!saved.enabled) await this.store.cancelOwner(ownerId, saved.epoch);
    return this.response(ownerId);
  }
  async reserve(ownerId: string, downloadId: string): Promise<void> {
    const preferences = await this.store.preferences(ownerId);
    if (!preferences.enabled) return;
    const plan: NotificationPlan = { id: randomUUID(), epoch: preferences.epoch,
      channels: [...new Set([preferences.defaultChannel, ...preferences.additionalChannels])], nextRunAt: new Date(this.now().getTime() + CHECK_INTERVAL_MS) };
    // A durable intent on the ordinary download record recovers a crash between remote add and local activation.
    await this.store.reserve(ownerId, downloadId, plan);
  }
  async submitted(ownerId: string, downloadId: string): Promise<void> {
    // A failed activation leaves the durable intent for the background recovery pass.
    try { await this.store.activate(ownerId, downloadId, this.now()); } catch { /* recover from Mongo intent */ }
  }
}
