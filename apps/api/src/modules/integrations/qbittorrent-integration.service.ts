import type {
  IntegrationFailureType,
  QBittorrentConfiguration,
  SaveQBittorrentConfigurationRequest,
} from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import type { AuthService } from '../auth/auth.service.js';
import { IntegrationValidationError } from './integration.service.js';
import { SecretCrypto } from './secret-crypto.js';
import type {
  QBittorrentClientPort,
  QBittorrentConfigRecord,
  QBittorrentConfigStore,
  QBittorrentCredential,
} from './qbittorrent.types.js';

export class QBittorrentIntegrationService {
  constructor(
    private readonly auth: AuthService,
    private readonly configs: QBittorrentConfigStore,
    private readonly client: QBittorrentClientPort,
    private readonly secrets: SecretCrypto,
    private readonly now: () => Date = () => new Date(),
  )
  {
  }

  async get(token: string | undefined): Promise<QBittorrentConfiguration> {
    return toResponse(await this.configs.find(await this.auth.requireOwnerId(token)));
  }

  async save(token: string | undefined, input: SaveQBittorrentConfigurationRequest): Promise<QBittorrentConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const baseUrl = normalizeQBittorrentBaseUrl(input.baseUrl);
    const existing = await this.configs.find(ownerId);
    const credential = credentialFromInput(input, existing, this.secrets, ownerId);
    const attemptedAt = this.now();
    let version: string;
    try {
      ({ version } = await this.client.verify(baseUrl, credential));
    } catch (error) {
      const failureType = failureTypeOf(error);
      await this.configs.recordFailure(ownerId, attemptedAt, failureType);
      throw qbittorrentAppError(error, 'qBittorrent validation failed');
    }
    const saved = await this.configs.saveVerified({
      ownerId,
      baseUrl,
      authMethod: credential.authMethod,
      ...(credential.authMethod === 'username_password' ? { username: credential.username } : {}),
      encryptedCredential: this.secrets.encrypt(JSON.stringify(credential), credentialContext(ownerId)),
      version,
      verifiedAt: attemptedAt,
      lastValidationAt: attemptedAt,
    });
    return toResponse(saved);
  }

  async retest(token: string | undefined): Promise<QBittorrentConfiguration> {
    const ownerId = await this.auth.requireOwnerId(token);
    const existing = await this.configs.find(ownerId);
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'qBittorrent is not configured');
    const attemptedAt = this.now();
    try {
      const { version } = await this.client.verify(existing.baseUrl, decryptCredential(existing, this.secrets));
      return toResponse(await this.configs.saveVerified({ ...existing, version, verifiedAt: attemptedAt, lastValidationAt: attemptedAt }));
    } catch (error) {
      await this.configs.recordFailure(ownerId, attemptedAt, failureTypeOf(error));
      throw qbittorrentAppError(error, 'qBittorrent validation failed');
    }
  }

  async delete(token: string | undefined): Promise<void> {
    await this.configs.delete(await this.auth.requireOwnerId(token));
  }
}

export function normalizeQBittorrentBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new AppError(400, 'QBITTORRENT_INVALID_URL', 'qBittorrent URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
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
    const value = JSON.parse(secrets.decrypt(record.encryptedCredential, credentialContext(record.ownerId))) as QBittorrentCredential;
    if (value.authMethod === 'api_key' && value.apiKey) return value;
    if (value.authMethod === 'username_password' && value.username && value.password) return value;
  } catch {}
  throw new AppError(500, 'INTERNAL_ERROR', 'Stored qBittorrent credentials are invalid');
}

function credentialFromInput(
  input: SaveQBittorrentConfigurationRequest,
  existing: QBittorrentConfigRecord | null,
  secrets: SecretCrypto,
  ownerId: string,
): QBittorrentCredential {
  const prior = existing?.authMethod === input.authMethod ? decryptCredential(existing, secrets) : null;
  if (input.authMethod === 'api_key') {
    const apiKey = input.apiKey?.trim() || (prior?.authMethod === 'api_key' ? prior.apiKey : '');
    if (!apiKey) throw new AppError(400, 'VALIDATION_ERROR', 'API key is required');
    return { authMethod: 'api_key', apiKey };
  }
  const username = input.username.trim();
  const password = input.password || (prior?.authMethod === 'username_password' && prior.username === username ? prior.password : '');
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
  if (failure === 'authentication' || failure === 'permission') return new AppError(502, 'QBITTORRENT_AUTH_FAILED', message);
  if (failure === 'timeout') return new AppError(504, 'QBITTORRENT_TIMEOUT', message);
  if (failure === 'network') return new AppError(503, 'QBITTORRENT_UNREACHABLE', message);
  return new AppError(502, 'QBITTORRENT_UNEXPECTED_RESPONSE', message);
}

function toResponse(record: QBittorrentConfigRecord | null): QBittorrentConfiguration {
  if (!record) return { provider: 'qbittorrent', status: 'unconfigured' };
  return {
    provider: 'qbittorrent',
    status: record.lastFailureType ? 'configured_invalid' : record.verifiedAt ? 'configured_valid' : 'configured_unverified',
    baseUrl: record.baseUrl,
    authMethod: record.authMethod,
    ...(record.username ? { username: record.username } : {}),
    ...(record.version ? { version: record.version } : {}),
    ...(record.lastValidationAt ? { lastValidationAt: record.lastValidationAt.toISOString() } : {}),
    ...(record.lastFailureType ? { lastFailureType: record.lastFailureType } : {}),
  };
}
