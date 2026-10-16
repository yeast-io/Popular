import { currentAiTrace, aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { OpenAIConfiguration } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { SecretCrypto } from './secret-crypto.js';

export interface OpenAIConfigRecord {
  ownerId: string;
  encryptedApiKey: string;
  maskedApiKey: string;
}
export interface OpenAIConfigStore {
  find(ownerId: string): Promise<OpenAIConfigRecord | null>;
  save(record: OpenAIConfigRecord): Promise<void>;
  delete(ownerId: string): Promise<void>;
}
export class OpenAISettingsService {
  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly store: OpenAIConfigStore,
    private readonly secrets: SecretCrypto,
  ) {}

  async get(token: string | undefined): Promise<OpenAIConfiguration> {
    const record = await this.store.find(await this.auth.requireOwnerId(token));
    return record ? { configured: true, maskedApiKey: record.maskedApiKey } : { configured: false };
  }

  async save(token: string | undefined, apiKey: string): Promise<OpenAIConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const key = apiKey.trim();
    if (key.length < 20 || key.length > 4096 || /\s/.test(key)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid API key format');
    }
    const maskedApiKey = `••••${key.slice(-4)}`;
    await this.store.save({ ownerId, maskedApiKey, encryptedApiKey: this.secrets.encrypt(key, this.context(ownerId)) });
    return { configured: true, maskedApiKey };
  }

  async delete(token: string | undefined): Promise<void> {
    await this.store.delete(await this.auth.requireOwnerId(token));
  }

  async requireApiKey(ownerId: string): Promise<string> {
    const record = await aiStep('credentials.load', () => this.store.find(ownerId));
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', 'Configure your OpenAI API key in Settings first');
    const key = await aiStep('credentials.decrypt', async () => this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId)));
    currentAiTrace()?.sensitive(key);
    return key;
  }

  private context(ownerId: string): string {
    return `movie-hub:integration:openai:owner:${ownerId}`;
  }
}
