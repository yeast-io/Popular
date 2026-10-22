import type { IntegrationPreferencesService } from './integration-preferences.service.js';
import { randomUUID } from 'node:crypto';
import { maskIntegrationSecret } from '@movie-hub/contract';
import { replacementSecret } from './integration-secret.domain.js';
import type {
  IntegrationFailureType,
  QBittorrentConfiguration,
  SaveQBittorrentConfigurationRequest,
} from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import { IntegrationValidationError } from './integration.service.js';
import { SecretCrypto } from './secret-crypto.js';
import { isPublicDownloaderAddress, isPublicDownloaderUrl } from './public-downloader-address.domain.js';
import type {
  QBittorrentClientPort,
  QBittorrentConfigRecord,
  QBittorrentConfigStore,
  QBittorrentCredential,
} from './qbittorrent.types.js';

export class QBittorrentIntegrationService {
  preferences?: IntegrationPreferencesService;

  constructor(
    private readonly auth: AuthService,
    private readonly configs: QBittorrentConfigStore,
    private readonly client: QBittorrentClientPort,
    private readonly secrets: SecretCrypto,
    private readonly now: () => Date = () => new Date()
  ) {}

  async list(token: string | undefined): Promise<QBittorrentConfiguration[]> {
    const ownerId = await this.auth.requireOwnerId(token);
    const records = this.configs.list ? await this.configs.list(ownerId) : [await this.configs.find(ownerId)].filter((record) => record !== null);
    return records.map((record) => toResponse(record, this.secrets));
  }

  async get(token: string | undefined, downloaderInstanceId?: string): Promise<QBittorrentConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const record = await this.load(ownerId, downloaderInstanceId);
    if (downloaderInstanceId && !record) throw new AppError(404, 'NOT_FOUND', 'qBittorrent instance not found');
    return toResponse(record, this.secrets);
  }

  async create(token: string | undefined, input: SaveQBittorrentConfigurationRequest): Promise<QBittorrentConfiguration> {
    return this.save(token, input, randomUUID(), true);
  }

  async save(token: string | undefined, input: SaveQBittorrentConfigurationRequest, downloaderInstanceId?: string, creating = false): Promise<QBittorrentConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const baseUrl = normalizeQBittorrentBaseUrl(input.baseUrl);
    const existing = creating ? null : await this.load(ownerId, downloaderInstanceId);
    if (downloaderInstanceId && !creating && !existing) throw new AppError(404, 'NOT_FOUND', 'qBittorrent instance not found');
    const name = (input.name ?? existing?.name ?? 'qBittorrent').trim();
    if (!name || name.length > 80) throw new AppError(400, 'VALIDATION_ERROR', 'Enter a downloader name');
    const credential = credentialFromInput(input, existing, this.secrets, ownerId);
    const attemptedAt = this.now();
    let version: string;
    try {
      ({ version } = await this.client.verify(baseUrl, credential));
    } catch (error) {
      const failureType = failureTypeOf(error);
      if (existing) await this.configs.recordFailure(ownerId, attemptedAt, failureType, existing.downloaderInstanceId);
      throw qbittorrentAppError(error, 'qBittorrent validation failed');
    }
    const instanceId = downloaderInstanceId ?? existing?.downloaderInstanceId ?? randomUUID();
    const saved = await this.configs.saveVerified({
      ownerId,
      downloaderInstanceId: instanceId,
      name,
      baseUrl,
      authMethod: credential.authMethod,
      ...(credential.authMethod === 'username_password' ? { username: credential.username } : {}),
      encryptedCredential: this.secrets.encrypt(JSON.stringify(credential), credentialContext(ownerId)),
      version,
      verifiedAt: attemptedAt,
      lastValidationAt: attemptedAt,
    });
    await this.preferences?.configured(ownerId, 'downloader', saved.downloaderInstanceId ?? 'qbittorrent');
    return toResponse(saved, this.secrets);
  }

  async retest(token: string | undefined, downloaderInstanceId?: string): Promise<QBittorrentConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = await this.load(ownerId, downloaderInstanceId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'qBittorrent is not configured');
    normalizeQBittorrentBaseUrl(existing.baseUrl);
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
      throw qbittorrentAppError(error, 'qBittorrent validation failed');
    }
  }

  async delete(token: string | undefined, downloaderInstanceId?: string): Promise<void> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = await this.load(ownerId, downloaderInstanceId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'qBittorrent instance not found');
    const id = existing.downloaderInstanceId ?? 'qbittorrent';
    await this.preferences?.beforeDelete(ownerId, 'downloader', id);
    await this.configs.delete(ownerId, existing.downloaderInstanceId);
    await this.preferences?.deleted(ownerId, 'downloader', id);
  }

  private async load(ownerId: string, downloaderInstanceId?: string): Promise<QBittorrentConfigRecord | null> {
    if (downloaderInstanceId) return this.configs.find(ownerId, downloaderInstanceId);
    const records = this.configs.list ? await this.configs.list(ownerId) : [await this.configs.find(ownerId)].filter((record) => record !== null);
    if (records.length > 1) throw new AppError(409, 'DOWNLOAD_PROVIDER_REQUIRED', 'Choose a downloader instance');
    return records[0] ?? null;
  }
}

export function normalizeQBittorrentBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError(400, 'QBITTORRENT_INVALID_URL', 'qBittorrent URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !isPublicDownloaderAddress(url)) {
    throw new AppError(400, 'QBITTORRENT_INVALID_URL', 'qBittorrent URL is invalid');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function credentialContext(ownerId: string): string {
  return `movie-hub:integration:qbittorrent:owner:${ownerId}`;
}

export function decryptCredential(record: QBittorrentConfigRecord, secrets: SecretCrypto): QBittorrentCredential {
  try {
    const value = JSON.parse(
      secrets.decrypt(record.encryptedCredential, credentialContext(record.ownerId))
    ) as QBittorrentCredential;
    if (value.authMethod === 'api_key' && value.apiKey) return value;
    if (value.authMethod === 'username_password' && value.username && value.password) return value;
  } catch {
    /* Return the same sanitized error for invalid ciphertext and invalid JSON. */
  }
  throw new AppError(500, 'INTERNAL_ERROR', 'Stored qBittorrent credentials are invalid');
}

function credentialFromInput(
  input: SaveQBittorrentConfigurationRequest,
  existing: QBittorrentConfigRecord | null,
  secrets: SecretCrypto,
  _ownerId: string
): QBittorrentCredential {
  const prior = existing?.authMethod === input.authMethod ? decryptCredential(existing, secrets) : null;
  if (input.authMethod === 'api_key') {
    const apiKey
      = replacementSecret(input.apiKey, prior?.authMethod === 'api_key' ? prior.apiKey : undefined)?.trim()
        || (prior?.authMethod === 'api_key' ? prior.apiKey : '');
    if (!apiKey) throw new AppError(400, 'VALIDATION_ERROR', 'API key is required');
    return { authMethod: 'api_key', apiKey };
  }
  const username = input.username.trim();
  const password
    = replacementSecret(input.password, prior?.authMethod === 'username_password' ? prior.password : undefined)
      || (prior?.authMethod === 'username_password' && prior.username === username ? prior.password : '');
  if (!password) throw new AppError(400, 'VALIDATION_ERROR', 'Password is required');
  return { authMethod: 'username_password', username, password };
}

function failureTypeOf(error: unknown): IntegrationFailureType {
  if (!(error instanceof IntegrationValidationError)) return 'network';
  if (error.failureType === 'permission' || error.failureType === 'rate_limited') return 'remote_error';
  return error.failureType;
}

export function qbittorrentAppError(error: unknown, message: string): AppError {
  const failure = error instanceof IntegrationValidationError ? error.failureType : 'network';
  const options = { cause: error };
  if (failure === 'authentication' || failure === 'permission')
    return new AppError(502, 'QBITTORRENT_AUTH_FAILED', message, undefined, options);
  if (failure === 'timeout') return new AppError(504, 'QBITTORRENT_TIMEOUT', message, undefined, options);
  if (failure === 'network') return new AppError(503, 'QBITTORRENT_UNREACHABLE', message, undefined, options);
  return new AppError(502, 'QBITTORRENT_UNEXPECTED_RESPONSE', message, undefined, options);
}

function toResponse(record: QBittorrentConfigRecord | null, secrets: SecretCrypto): QBittorrentConfiguration {
  if (!record) return { provider: 'qbittorrent', status: 'unconfigured' };
  const credential = decryptCredential(record, secrets);
  return {
    provider: 'qbittorrent',
    ...(record.downloaderInstanceId ? { downloaderInstanceId: record.downloaderInstanceId } : {}),
    ...(record.name ? { name: record.name } : {}),
    ...(credential.authMethod === 'api_key'
      ? { apiKeyMasked: maskIntegrationSecret(credential.apiKey) }
      : { passwordMasked: maskIntegrationSecret(credential.password) }),
    status: !isPublicDownloaderUrl(record.baseUrl) || record.lastFailureType
      ? 'configured_invalid'
      : record.verifiedAt
        ? 'configured_valid'
        : 'configured_unverified',
    baseUrl: record.baseUrl,
    authMethod: record.authMethod,
    ...(record.username ? { username: record.username } : {}),
    ...(record.version ? { version: record.version } : {}),
    ...(record.lastValidationAt ? { lastValidationAt: record.lastValidationAt.toISOString() } : {}),
    ...(record.lastFailureType ? { lastFailureType: record.lastFailureType } : {}),
  };
}
