import type { IntegrationPreferencesService } from './integration-preferences.service.js';
import { randomUUID } from 'node:crypto';
import { maskIntegrationSecret } from '@movie-hub/contract';
import { replacementSecret } from './integration-secret.domain.js';
import type {
  IntegrationFailureType,
  TransmissionConfiguration,
  SaveTransmissionConfigurationRequest,
} from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import { IntegrationValidationError } from './integration.service.js';
import { SecretCrypto } from './secret-crypto.js';
import { isPublicDownloaderAddress, isPublicDownloaderUrl } from './public-downloader-address.domain.js';
import type {
  TransmissionClientPort,
  TransmissionConfigRecord,
  TransmissionConfigStore,
  TransmissionCredential,
} from './transmission.types.js';

export class TransmissionIntegrationService {
  preferences?: IntegrationPreferencesService;

  constructor(
    private readonly auth: AuthService,
    private readonly configs: TransmissionConfigStore,
    private readonly client: Pick<TransmissionClientPort, 'verify'>,
    private readonly secrets: SecretCrypto,
    private readonly now: () => Date = () => new Date()
  ) {}

  async list(token: string | undefined): Promise<TransmissionConfiguration[]> {
    const ownerId = await this.auth.requireOwnerId(token);
    const records = this.configs.list ? await this.configs.list(ownerId) : [await this.configs.find(ownerId)].filter((record) => record !== null);
    return records.map((record) => toResponse(record, this.secrets));
  }

  async get(token: string | undefined, downloaderInstanceId?: string): Promise<TransmissionConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const record = await this.load(ownerId, downloaderInstanceId);
    if (downloaderInstanceId && !record) throw new AppError(404, 'NOT_FOUND', 'Transmission instance not found');
    return toResponse(record, this.secrets);
  }

  async create(token: string | undefined, input: SaveTransmissionConfigurationRequest): Promise<TransmissionConfiguration> {
    return this.save(token, input, randomUUID(), true);
  }

  async save(
    token: string | undefined,
    input: SaveTransmissionConfigurationRequest,
    downloaderInstanceId?: string,
    creating = false
  ): Promise<TransmissionConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const baseUrl = normalizeTransmissionBaseUrl(input.baseUrl);
    const existing = creating ? null : await this.load(ownerId, downloaderInstanceId);
    if (downloaderInstanceId && !creating && !existing) throw new AppError(404, 'NOT_FOUND', 'Transmission instance not found');
    const name = (input.name ?? existing?.name ?? 'Transmission').trim();
    if (!name || name.length > 80) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a downloader name');
    const credential = credentialFromInput(input, baseUrl, existing, this.secrets);
    const attemptedAt = this.now();
    let version: string;
    try {
      ({ version } = await this.client.verify(baseUrl, credential));
    } catch (error) {
      throw transmissionAppError(error, 'Transmission validation failed');
    }
    const instanceId = downloaderInstanceId ?? existing?.downloaderInstanceId ?? randomUUID();
    const saved = await this.configs.saveVerified({
      ownerId,
      downloaderInstanceId: instanceId,
      name,
      baseUrl,
      username: credential.username,
      encryptedCredential: this.secrets.encrypt(JSON.stringify(credential), credentialContext(ownerId)),
      version,
      verifiedAt: attemptedAt,
      lastValidationAt: attemptedAt,
    });
    await this.preferences?.configured(ownerId, 'downloader', saved.downloaderInstanceId ?? 'transmission');
    return toResponse(saved, this.secrets);
  }

  async retest(token: string | undefined, downloaderInstanceId?: string): Promise<TransmissionConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = await this.load(ownerId, downloaderInstanceId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Transmission is not configured');
    normalizeTransmissionBaseUrl(existing.baseUrl);
    const attemptedAt = this.now();
    try {
      const { version } = await this.client.verify(existing.baseUrl, decryptCredential(existing, this.secrets));
      return toResponse(
        await this.configs.saveVerified({
          ...existing,
          version,
          verifiedAt: attemptedAt,
          lastValidationAt: attemptedAt,
        }),
        this.secrets
      );
    } catch (error) {
      await this.configs.recordFailure(ownerId, attemptedAt, failureTypeOf(error), existing.downloaderInstanceId);
      throw transmissionAppError(error, 'Transmission validation failed');
    }
  }

  async delete(token: string | undefined, downloaderInstanceId?: string): Promise<void> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = await this.load(ownerId, downloaderInstanceId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Transmission instance not found');
    const id = existing.downloaderInstanceId ?? 'transmission';
    await this.preferences?.beforeDelete(ownerId, 'downloader', id);
    await this.configs.delete(ownerId, existing.downloaderInstanceId);
    await this.preferences?.deleted(ownerId, 'downloader', id);
  }

  private async load(ownerId: string, downloaderInstanceId?: string): Promise<TransmissionConfigRecord | null> {
    if (downloaderInstanceId) return this.configs.find(ownerId, downloaderInstanceId);
    const records = this.configs.list ? await this.configs.list(ownerId) : [await this.configs.find(ownerId)].filter((record) => record !== null);
    if (records.length > 1) throw new AppError(409, 'DOWNLOAD_PROVIDER_REQUIRED', 'Choose a downloader instance');
    return records[0] ?? null;
  }
}

export function normalizeTransmissionBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError(400, 'TRANSMISSION_INVALID_URL', 'Transmission URL is invalid');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/'
    || !isPublicDownloaderAddress(url)
  ) {
    throw new AppError(400, 'TRANSMISSION_INVALID_URL', 'Transmission URL is invalid');
  }
  return url.origin;
}

export function credentialContext(ownerId: string): string {
  return `movie-hub:integration:transmission:owner:${ownerId}`;
}

export function decryptCredential(record: TransmissionConfigRecord, secrets: SecretCrypto): TransmissionCredential {
  try {
    const value = JSON.parse(
      secrets.decrypt(record.encryptedCredential, credentialContext(record.ownerId))
    ) as TransmissionCredential;
    if (typeof value.username === 'string' && value.username && typeof value.password === 'string' && value.password)
      return value;
  } catch {
    /* Return the same sanitized error for invalid ciphertext and invalid JSON. */
  }
  throw new AppError(500, 'INTERNAL_ERROR', 'Stored Transmission credentials are invalid');
}

function credentialFromInput(
  input: SaveTransmissionConfigurationRequest,
  baseUrl: string,
  existing: TransmissionConfigRecord | null,
  secrets: SecretCrypto
): TransmissionCredential {
  const username = input.username.trim();
  if (!username || username.includes(':'))
    throw new AppError(400, 'VALIDATION_ERROR', 'A username without colons is required');
  const canRetain = existing?.baseUrl === baseUrl && existing.username === username;
  const password
    = replacementSecret(input.password, existing ? decryptCredential(existing, secrets).password : undefined)
      || (canRetain ? decryptCredential(existing, secrets).password : '');
  if (!password)
    throw new AppError(400, 'VALIDATION_ERROR', 'Password is required when the address or username changes');
  return { username, password };
}

function failureTypeOf(error: unknown): IntegrationFailureType {
  if (!(error instanceof IntegrationValidationError)) return 'network';
  if (error.failureType === 'permission' || error.failureType === 'rate_limited') return 'remote_error';
  return error.failureType;
}

export function transmissionAppError(error: unknown, message: string): AppError {
  const failure = error instanceof IntegrationValidationError ? error.failureType : 'network';
  if (failure === 'authentication' || failure === 'permission')
    return new AppError(502, 'TRANSMISSION_AUTH_FAILED', message);
  if (failure === 'timeout') return new AppError(504, 'TRANSMISSION_TIMEOUT', message);
  if (failure === 'network') return new AppError(503, 'TRANSMISSION_UNREACHABLE', message);
  return new AppError(502, 'TRANSMISSION_UNEXPECTED_RESPONSE', message);
}

function toResponse(record: TransmissionConfigRecord | null, secrets: SecretCrypto): TransmissionConfiguration {
  if (!record) return { provider: 'transmission', status: 'unconfigured' };
  return {
    provider: 'transmission',
    ...(record.downloaderInstanceId ? { downloaderInstanceId: record.downloaderInstanceId } : {}),
    ...(record.name ? { name: record.name } : {}),
    passwordMasked: maskIntegrationSecret(decryptCredential(record, secrets).password),
    status: !isPublicDownloaderUrl(record.baseUrl) || record.lastFailureType
      ? 'configured_invalid'
      : record.verifiedAt
        ? 'configured_valid'
        : 'configured_unverified',
    baseUrl: record.baseUrl,
    ...(record.username ? { username: record.username } : {}),
    ...(record.version ? { version: record.version } : {}),
    ...(record.lastValidationAt ? { lastValidationAt: record.lastValidationAt.toISOString() } : {}),
    ...(record.lastFailureType ? { lastFailureType: record.lastFailureType } : {}),
  };
}
