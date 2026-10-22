import { createHash, randomBytes } from 'node:crypto';
import type {
  RemoteClientConfiguration,
  RemoteClientMutation,
  RemoteClientMutationResult,
  RemoteClientUnbind,
  RemoteClientKey,
  Locale,
  RemoteAuthorizationChange,
} from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { AiTrace, aiStep, currentAiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { SecretCrypto } from '../integrations/secret-crypto.js';
import { remoteClientMessages } from './remote-client.messages.js';
import type {
  AuthorizationGateway,
  RemoteAuthorizationStore,
  RemoteClientOperation,
  RemoteClientDiagnostics,
} from './remote-client.types.js';

export class RemoteClientService {
  constructor(
    private readonly store: RemoteAuthorizationStore,
    private readonly gateway: AuthorizationGateway,
    private readonly secrets: SecretCrypto
  ) {}

  async get(ownerId: string): Promise<RemoteClientConfiguration> {
    const account = await aiStep('remote-client.account.read', () => this.store.account(ownerId));
    const key = account.key;
    const devices = key?.active
      ? await aiStep('remote-client.devices.read', () => {
          return this.store.devices(ownerId, key.authVersion);
        })
      : [];
    // Include pending unbind notifications even though the unbound row is no longer in the device list.
    const pending = await aiStep('remote-client.notifications.read', () => this.store.pending(ownerId));
    return {
      hasKey: key?.active ?? false,
      canReadKey: Boolean(key?.active && key.encryptedKey),
      authVersion: key?.authVersion ?? 0,
      deviceLimit: account.deviceLimit,
      devices: devices.map((device) => {
        return {
          id: device.deviceId,
          authVersion: device.authVersion,
          deviceVersion: device.deviceVersion,
          boundAt: device.boundAt.toISOString(),
        };
      }),
      gatewayNotificationPending: pending.some((event) => event.ownerId === ownerId),
    };
  }

  async readKey(ownerId: string, locale: Locale): Promise<RemoteClientKey> {
    const { key } = await aiStep('remote-client.key.read', () => this.store.account(ownerId));
    if (!key?.active) throw new AppError(404, 'NOT_FOUND', remoteClientMessages[locale].missing);
    if (!key.encryptedKey) throw new AppError(409, 'CONFLICT', remoteClientMessages[locale].legacy);
    try {
      const apiKey = await aiStep('remote-client.key.decrypt', async () => {
        return this.secrets.decrypt(key.encryptedKey!, this.context(ownerId, key.authVersion));
      });
      currentAiTrace()?.sensitive(apiKey);
      if (createHash('sha256').update(apiKey).digest('hex') !== key.keyDigest)
        throw new Error('RCCK ciphertext/digest mismatch');
      return { apiKey, authVersion: key.authVersion };
    } catch (cause) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', remoteClientMessages[locale].unreadable, undefined, { cause });
    }
  }

  async change(
    ownerId: string,
    operation: RemoteClientOperation,
    input: RemoteClientMutation,
    correlationId: string,
    locale: Locale
  ): Promise<RemoteClientMutationResult> {
    const { key: previous } = await aiStep('remote-client.key.read', () => this.store.account(ownerId));
    const receipt = previous?.operations.find((item) => item.operationId === input.operationId);
    if (receipt) {
      if (receipt.kind !== operation || receipt.expectedAuthVersion !== input.expectedAuthVersion)
        this.conflict(locale);
      if (previous?.pending) await this.deliver(previous.pending);
      return this.keyResult(ownerId, operation, input, locale);
    }
    if (
      (previous?.authVersion ?? 0) !== input.expectedAuthVersion
      || (operation === 'generate' ? Boolean(previous?.active) : !previous?.active)
    )
      this.conflict(locale);
    const apiKey = operation === 'revoke' ? undefined : `premote_${randomBytes(32).toString('base64url')}`;
    if (apiKey) currentAiTrace()?.sensitive(apiKey);
    const version = input.expectedAuthVersion + 1;
    const encrypted = apiKey
      ? await aiStep('remote-client.key.encrypt', async () => {
          return {
            keyDigest: createHash('sha256').update(apiKey).digest('hex'),
            encryptedKey: this.secrets.encrypt(apiKey, this.context(ownerId, version)),
          };
        })
      : undefined;
    const event: RemoteAuthorizationChange = {
      scope: 'key',
      eventId: input.operationId,
      ownerId,
      authVersion: version,
      correlationId,
    };
    const changed = await aiStep('remote-client.key.update', () => {
      return this.store.changeKey(ownerId, operation, input, encrypted, event);
    });
    if (!changed) {
      const winner = (await this.store.account(ownerId)).key;
      if (
        !winner?.operations.some((item) => {
          return (
            item.operationId === input.operationId
            && item.kind === operation
            && item.expectedAuthVersion === input.expectedAuthVersion
          );
        })
      )
        this.conflict(locale);
    } else await this.deliver(event);
    return this.keyResult(ownerId, operation, input, locale);
  }

  async unbind(
    ownerId: string,
    deviceId: string,
    input: RemoteClientUnbind,
    correlationId: string,
    locale: Locale
  ): Promise<RemoteClientConfiguration> {
    const device = await aiStep('remote-client.device.read', () => this.store.device(ownerId, deviceId));
    if (!device) throw new AppError(404, 'NOT_FOUND', remoteClientMessages[locale].missing);
    const receipt = device.operations.find((item) => item.operationId === input.operationId);
    if (receipt) {
      if (
        receipt.expectedAuthVersion !== input.expectedAuthVersion
        || receipt.expectedDeviceVersion !== input.expectedDeviceVersion
      )
        this.conflict(locale);
      if (device.pending) await this.deliver(device.pending);
      return this.get(ownerId);
    }
    const { key } = await this.store.account(ownerId);
    if (
      !key?.active
      || key.authVersion !== input.expectedAuthVersion
      || device.authVersion !== key.authVersion
      || device.deviceVersion !== input.expectedDeviceVersion
      || device.status !== 'bound'
    )
      this.conflict(locale);
    const event: RemoteAuthorizationChange = {
      scope: 'device',
      eventId: input.operationId,
      ownerId,
      authVersion: input.expectedAuthVersion,
      deviceId,
      deviceVersion: input.expectedDeviceVersion + 1,
      correlationId,
    };
    const changed = await aiStep('remote-client.device.unbind', () => {
      return this.store.unbind(ownerId, deviceId, input, event);
    });
    if (!changed) {
      const winner = await this.store.device(ownerId, deviceId);
      if (
        !winner?.operations.some((item) => {
          return (
            item.operationId === input.operationId
            && item.expectedAuthVersion === input.expectedAuthVersion
            && item.expectedDeviceVersion === input.expectedDeviceVersion
          );
        })
      )
        this.conflict(locale);
    } else await this.deliver(event);
    return this.get(ownerId);
  }

  async retryNotifications(diagnostics?: RemoteClientDiagnostics): Promise<void> {
    for (const event of await this.store.pending()) {
      if (!diagnostics) {
        await this.deliver(event);
        continue;
      }
      const trace = new AiTrace(
        diagnostics.logger,
        { correlationId: event.correlationId, ownerId: event.ownerId },
        '',
        'remote-client.notification',
        diagnostics.verbose
      );
      await withAiTrace(trace, () => this.deliver(event));
    }
  }

  private async deliver(event: RemoteAuthorizationChange): Promise<void> {
    const trace = currentAiTrace();
    try {
      await aiStep('remote-client.gateway.notify', () => this.gateway.notify(event));
      await aiStep('remote-client.gateway.acknowledge', () => this.store.acknowledge(event));
    } catch (error) {
      trace?.fail(error, { outcome: 'notification-pending', ownerId: event.ownerId, scope: event.scope });
      trace?.clearFailure();
    }
  }

  private async keyResult(
    ownerId: string,
    operation: RemoteClientOperation,
    input: RemoteClientMutation,
    locale: Locale
  ): Promise<RemoteClientMutationResult> {
    const configuration = await this.get(ownerId);
    const canReturn
      = operation !== 'revoke' && configuration.hasKey && configuration.authVersion === input.expectedAuthVersion + 1;
    if (!canReturn) return { configuration, apiKey: null };
    const revealed = await this.readKey(ownerId, locale);
    // A different mutation can win between the metadata snapshot and decryption.
    if (revealed.authVersion !== configuration.authVersion)
      return { configuration: await this.get(ownerId), apiKey: null };
    return { configuration, apiKey: revealed.apiKey };
  }

  private context(ownerId: string, authVersion: number): string {
    return `remote-client:rcck:${ownerId}:${authVersion}`;
  }

  private conflict(locale: Locale): never {
    throw new AppError(409, 'CONFLICT', remoteClientMessages[locale].conflict);
  }
}
