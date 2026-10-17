import { currentAiTrace, aiStep } from '../../infrastructure/logging/ai-trace.js';
import type { OpenAIConfiguration, OpenAIValidation } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { SecretCrypto } from './secret-crypto.js';

export interface OpenAIConfigRecord {
  ownerId: string;
  encryptedApiKey: string;
  maskedApiKey: string;
  validation?: OpenAIValidation;
}
export interface OpenAIConfigStore {
  find(ownerId: string): Promise<OpenAIConfigRecord | null>;
  save(record: OpenAIConfigRecord): Promise<void>;
  delete(ownerId: string): Promise<void>;
  saveValidation(ownerId: string, encryptedApiKey: string, validation: OpenAIValidation): Promise<boolean>;
}
export class OpenAIProbeError extends Error {
  constructor(readonly reason: NonNullable<OpenAIValidation['failureReason']>) { super('OpenAI connection verification failed'); }
}
export class OpenAISettingsService {
  private readonly pending = new Map<string, Promise<OpenAIConfiguration>>();
  private readonly lastAttempt = new Map<string, number>();
  constructor(
    private readonly auth: Pick<AuthService, 'requireOwnerId'>,
    private readonly store: OpenAIConfigStore,
    private readonly secrets: SecretCrypto,
    private readonly verification?: { model: string; verify(apiKey: string): Promise<void> },
  ) {}

  async get(token: string | undefined): Promise<OpenAIConfiguration> {
    const record = await this.store.find(await this.auth.requireOwnerId(token));
    return record ? this.response(record) : { configured: false };
  }

  async save(token: string | undefined, apiKey: string): Promise<OpenAIConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const key = apiKey.trim();
    if (key.length < 20 || key.length > 4096 || /\s/.test(key)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid API key format');
    }
    const maskedApiKey = `••••${key.slice(-4)}`;
    await this.store.save({ ownerId, maskedApiKey, encryptedApiKey: this.secrets.encrypt(key, this.context(ownerId)) });
    return this.response({ ownerId, encryptedApiKey: '', maskedApiKey });
  }

  private response(record: OpenAIConfigRecord): OpenAIConfiguration {
    return { configured: true, maskedApiKey: record.maskedApiKey,
      ...(this.verification ? { model: this.verification.model } : {}),
      ...(record.validation && record.validation.method === 'model_lookup' && record.validation.model === this.verification?.model ? { validation: record.validation } : {}),
    };
  }
  async test(token: string | undefined): Promise<OpenAIConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = this.pending.get(ownerId);
    if (existing) return existing;
    const operation = this.verify(ownerId);
    this.pending.set(ownerId, operation);
    try { return await operation; } finally { if (this.pending.get(ownerId) === operation) this.pending.delete(ownerId); }
  }
  private async verify(ownerId: string): Promise<OpenAIConfiguration> {
    const record = await this.store.find(ownerId);
    if (!record) throw new AppError(403, 'OPENAI_NOT_CONFIGURED', 'Save an API key before testing');
    if (!this.verification) throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Connection verification is unavailable');
    if (Date.now() - (this.lastAttempt.get(ownerId) ?? 0) < 30_000) throw new AppError(409, 'CONFLICT', 'Wait 30 seconds before another connection test');
    const key = this.secrets.decrypt(record.encryptedApiKey, this.context(ownerId));
    this.lastAttempt.set(ownerId, Date.now());
    let validation: OpenAIValidation;
    try {
      await this.verification.verify(key);
      validation = { method: 'model_lookup', status: 'valid', checkedAt: new Date().toISOString(), model: this.verification.model };
    } catch (error) {
      validation = { method: 'model_lookup', status: 'failed', checkedAt: new Date().toISOString(), model: this.verification.model,
        failureReason: error instanceof OpenAIProbeError ? error.reason : 'request_failed' };
    }
    if (!await this.store.saveValidation(ownerId, record.encryptedApiKey, validation)) {
      throw new AppError(409, 'CONFLICT', 'API key changed during testing; test the current key again');
    }
    return this.response({ ...record, validation });
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
