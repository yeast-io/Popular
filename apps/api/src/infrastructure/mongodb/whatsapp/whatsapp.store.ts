import type { Model } from 'mongoose';
import type { WhatsAppSessionDocument } from './whatsapp.schema.js';
import type { WhatsAppStore } from '../../../modules/whatsapp/whatsapp.types.js';
import type { SecretCrypto } from '../../../modules/integrations/secret-crypto.js';

const context = (ownerId: string) => `whatsapp:${ownerId}:auth:v1`;

export class MongoWhatsAppStore implements WhatsAppStore {
  constructor(
    private readonly model: Model<WhatsAppSessionDocument>,
    private readonly secrets: SecretCrypto
  ) {}
  async exists(ownerId: string): Promise<boolean> {
    const row = await this.model.findOne({ ownerId }).select('+encryptedState').lean().exec();
    if (!row?.encryptedState) return false;
    const state = JSON.parse(this.secrets.decrypt(row.encryptedState, context(ownerId))) as {
      creds?: { me?: { id?: string } };
    };
    return Boolean(state.creds?.me?.id);
  }
  async acquire(ownerId: string, leaseId: string): Promise<boolean> {
    try {
      const row = await this.model
        .findOneAndUpdate(
          { ownerId, $or: [{ leaseUntil: { $lte: new Date() } }, { leaseUntil: { $exists: false } }] },
          { $set: { leaseId, leaseUntil: new Date(Date.now() + 60_000) }, $setOnInsert: { ownerId } },
          { upsert: true, new: true },
        )
        .exec();
      return !!row;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }
  private owned(ownerId: string, leaseId: string) {
    return { ownerId, leaseId, leaseUntil: { $gt: new Date() } };
  }
  async renew(ownerId: string, leaseId: string): Promise<boolean> {
    const result = await this.model
      .updateOne(this.owned(ownerId, leaseId), { $set: { leaseUntil: new Date(Date.now() + 60_000) } })
      .exec();
    return result.matchedCount === 1;
  }
  async release(ownerId: string, leaseId: string): Promise<void> {
    await this.model.updateOne({ ownerId, leaseId }, { $unset: { leaseId: 1, leaseUntil: 1 } }).exec();
  }
  async load(ownerId: string, leaseId: string): Promise<string | null> {
    const row = await this.model.findOne(this.owned(ownerId, leaseId)).select('+encryptedState').lean().exec();
    if (!row) throw new Error('WhatsApp lease lost');
    return row.encryptedState ? this.secrets.decrypt(row.encryptedState, context(ownerId)) : null;
  }
  async save(ownerId: string, leaseId: string, state: string): Promise<void> {
    const result = await this.model
      .updateOne(this.owned(ownerId, leaseId), {
        $set: { encryptedState: this.secrets.encrypt(state, context(ownerId)) },
      })
      .exec();
    if (result.matchedCount !== 1) throw new Error('WhatsApp lease lost');
  }
  async clear(ownerId: string, leaseId: string): Promise<void> {
    const result = await this.model.updateOne(this.owned(ownerId, leaseId), { $unset: { encryptedState: 1 } }).exec();
    if (result.matchedCount !== 1) throw new Error('WhatsApp lease lost');
  }
}
