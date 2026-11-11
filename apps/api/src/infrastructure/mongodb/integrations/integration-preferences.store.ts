import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import type { IntegrationCategory } from '@movie-hub/contract';
import type { IntegrationPreferencesStore } from '../../../modules/integrations/integration-preferences.types.js';
import type { IntegrationPreferencesDocument } from './integration-preferences.schema.js';

export class MongoIntegrationPreferencesStore implements IntegrationPreferencesStore {
  constructor(private readonly model: Model<IntegrationPreferencesDocument>) {}

  async read(ownerId: string) {
    const row = await this.model.findOne({ ownerId }).lean().exec();
    return {
      ...(row?.resourceExecutionId ? { resourceExecutionId: row.resourceExecutionId } : {}),
      ...(row?.resourceAgentDeviceId ? { resourceAgentDeviceId: row.resourceAgentDeviceId } : {}),
      ...(row?.agentSelectedSites ? { agentSelectedSites: [...row.agentSelectedSites] } : {}),
      ...(row?.agentDefaultSite ? { agentDefaultSite: row.agentDefaultSite } : {}),
      defaults: {
        ...(row?.defaults?.resource ? { resource: row.defaults.resource } : {}),
        ...(row?.defaults?.downloader ? { downloader: row.defaults.downloader } : {}),
        ...(row?.defaults?.ai ? { ai: row.defaults.ai } : {}),
      },
      selectedSites: [...(row?.selectedSites ?? [])],
    };
  }

  private async ensure(ownerId: string): Promise<void> {
    try {
      await this.model
        .updateOne({ ownerId }, { $setOnInsert: { ownerId, selectedSites: [] } }, { upsert: true })
        .exec();
    } catch (error) {
      if (!(typeof error === 'object' && error && 'code' in error && error.code === 11000)) throw error;
    }
  }

  async setDefault(ownerId: string, category: IntegrationCategory, id: string, onlyIfMissing = false): Promise<void> {
    await this.ensure(ownerId);
    const field = `defaults.${category}`;
    await this.model
      .updateOne({ ownerId, ...(onlyIfMissing ? { [field]: { $exists: false } } : {}) }, { $set: { [field]: id } })
      .exec();
  }

  async selectSites(ownerId: string, sites: string[]): Promise<void> {
    await this.ensure(ownerId);
    await this.model.updateOne({ ownerId }, { $set: { selectedSites: sites } }).exec();
  }

  async setResourceAgent(ownerId: string, deviceId: string | null, sites: string[]): Promise<void> {
    await this.ensure(ownerId);
    await this.model
      .updateOne(
        { ownerId },
        deviceId
          ? {
              $set: {
                resourceExecutionId: randomUUID(),
                resourceAgentDeviceId: deviceId,
                agentSelectedSites: sites,
                ...(sites[0] ? { agentDefaultSite: sites[0] } : {}),
              },
              ...(!sites[0] ? { $unset: { agentDefaultSite: 1 } } : {}),
            }
          : { $set: { resourceExecutionId: randomUUID() }, $unset: { resourceAgentDeviceId: 1 } }
      )
      .exec();
  }

  async selectAgentSites(ownerId: string, sites: string[]): Promise<void> {
    await this.ensure(ownerId);
    await this.model.updateOne({ ownerId }, { $set: { agentSelectedSites: sites } }).exec();
  }

  async setAgentDefault(ownerId: string, id: string): Promise<void> {
    await this.ensure(ownerId);
    await this.model.updateOne({ ownerId }, { $set: { agentDefaultSite: id } }).exec();
  }

  async remove(ownerId: string, category: IntegrationCategory, id: string): Promise<void> {
    const field = `defaults.${category}`;
    await this.model.updateOne({ ownerId, [field]: id }, { $unset: { [field]: 1 } }).exec();
    if (category === 'resource') await this.model.updateOne({ ownerId }, { $pull: { selectedSites: id } }).exec();
  }
}
