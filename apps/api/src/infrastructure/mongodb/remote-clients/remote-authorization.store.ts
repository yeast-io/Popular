import type { Model } from 'mongoose';
import type { RemoteDeviceDocument } from './remote-authorization.schema.js';
import type { RemoteAuthorizationChange, RemoteClientMutation, RemoteClientUnbind } from '@movie-hub/contract';
import type { UserDocument } from '../users/user.schema.js';
import type {
  RemoteAuthorizationStore,
  RemoteClientOperation,
  RemoteKeySecrets,
  RemoteClientAccount,
  RemoteDeviceRecord,
} from '../../../modules/remote-clients/remote-client.types.js';

export class MongoRemoteAuthorizationStore implements RemoteAuthorizationStore {
  constructor(private readonly users: Model<UserDocument>, private readonly bindings: Model<RemoteDeviceDocument>) {}

  async account(ownerId: string): Promise<RemoteClientAccount> {
    const row = await this.users.findById(ownerId).select('+rcck').lean().exec();
    const key = row?.rcck;
    return {
      deviceLimit: row?.remoteDeviceLimit ?? 1,
      key: key
        ? {
            ownerId,
            authVersion: key.authVersion,
            active: key.active,
            ...(key.keyDigest ? { keyDigest: key.keyDigest } : {}),
            ...(key.encryptedKey ? { encryptedKey: key.encryptedKey } : {}),
            operations: key.operations.map((item) => {
              return { operationId: item.operationId, kind: item.kind, expectedAuthVersion: item.expectedAuthVersion };
            }),
            ...(key.pendingGatewayChange ? { pending: this.event(key.pendingGatewayChange) } : {}),
          }
        : null,
    };
  }

  async changeKey(
    ownerId: string,
    operation: RemoteClientOperation,
    input: RemoteClientMutation,
    secrets: RemoteKeySecrets | undefined,
    event: RemoteAuthorizationChange
  ): Promise<boolean> {
    const filter = {
      '_id': ownerId,
      ...(input.expectedAuthVersion === 0
        ? { rcck: { $exists: false } }
        : { 'rcck.authVersion': input.expectedAuthVersion, 'rcck.active': operation !== 'generate' }),
      'rcck.operations.operationId': { $ne: input.operationId },
    };
    const result = await this.users
      .updateOne(
        filter,
        {
          $set: {
            'rcck.active': operation !== 'revoke',
            'rcck.pendingGatewayChange': event,
            ...(secrets ? { 'rcck.keyDigest': secrets.keyDigest, 'rcck.encryptedKey': secrets.encryptedKey } : {}),
          },
          $inc: { 'rcck.authVersion': 1 },
          $push: {
            'rcck.operations': {
              operationId: input.operationId,
              kind: operation,
              expectedAuthVersion: input.expectedAuthVersion,
            },
          },
          ...(operation === 'revoke' ? { $unset: { 'rcck.encryptedKey': 1 } } : {}),
        },
        { runValidators: true }
      )
      .exec();
    return result.modifiedCount === 1;
  }

  async devices(ownerId: string, authVersion: number): Promise<RemoteDeviceRecord[]> {
    const rows = await this.bindings
      .find({ ownerId, authVersion, status: 'bound' })
      .sort({ boundAt: 1, deviceId: 1 })
      .lean()
      .exec();
    return rows.map((row) => this.deviceRecord(row));
  }

  async device(ownerId: string, deviceId: string): Promise<RemoteDeviceRecord | null> {
    const row = await this.bindings.findOne({ ownerId, deviceId }).lean().exec();
    return row ? this.deviceRecord(row) : null;
  }

  async unbind(
    ownerId: string,
    deviceId: string,
    input: RemoteClientUnbind,
    event: RemoteAuthorizationChange
  ): Promise<boolean> {
    const result = await this.bindings
      .updateOne(
        {
          ownerId,
          deviceId,
          'authVersion': input.expectedAuthVersion,
          'deviceVersion': input.expectedDeviceVersion,
          'status': 'bound',
          'operations.operationId': { $ne: input.operationId },
        },
        {
          $set: { status: 'unbound', unboundAt: new Date(), pendingGatewayChange: event },
          $inc: { deviceVersion: 1 },
          $push: {
            operations: {
              operationId: input.operationId,
              expectedAuthVersion: input.expectedAuthVersion,
              expectedDeviceVersion: input.expectedDeviceVersion,
            },
          },
        },
        { runValidators: true }
      )
      .exec();
    return result.modifiedCount === 1;
  }

  async pending(ownerId?: string): Promise<RemoteAuthorizationChange[]> {
    const users = await this.users
      .find({ ...(ownerId ? { _id: ownerId } : {}), 'rcck.pendingGatewayChange': { $exists: true } })
      .select('+rcck')
      .lean()
      .exec();
    const devices = await this.bindings
      .find({ ...(ownerId ? { ownerId } : {}), pendingGatewayChange: { $exists: true } })
      .lean()
      .exec();
    return [
      ...users.flatMap((row) => (row.rcck?.pendingGatewayChange ? [this.event(row.rcck.pendingGatewayChange)] : [])),
      ...devices.flatMap((row) => (row.pendingGatewayChange ? [this.event(row.pendingGatewayChange)] : [])),
    ];
  }

  async acknowledge(event: RemoteAuthorizationChange): Promise<void> {
    if (event.scope === 'key') {
      await this.users
        .updateOne(
          {
            '_id': event.ownerId,
            'rcck.pendingGatewayChange.eventId': event.eventId,
            'rcck.pendingGatewayChange.authVersion': event.authVersion,
          },
          { $unset: { 'rcck.pendingGatewayChange': 1 } }
        )
        .exec();
    } else {
      await this.bindings
        .updateOne(
          {
            'ownerId': event.ownerId,
            'deviceId': event.deviceId,
            'pendingGatewayChange.eventId': event.eventId,
            'pendingGatewayChange.deviceVersion': event.deviceVersion,
          },
          { $unset: { pendingGatewayChange: 1 } }
        )
        .exec();
    }
  }

  private event(row: {
    scope: string;
    eventId: string;
    ownerId: string;
    authVersion: number;
    correlationId: string;
    deviceId?: string | null;
    deviceVersion?: number | null;
  }): RemoteAuthorizationChange {
    const base = {
      eventId: row.eventId,
      ownerId: row.ownerId,
      authVersion: row.authVersion,
      correlationId: row.correlationId,
    };
    if (row.scope === 'key') return { scope: 'key', ...base };
    if (!row.deviceId || row.deviceVersion == null) throw new Error('Invalid device authorization notification');
    return { scope: 'device', ...base, deviceId: row.deviceId, deviceVersion: row.deviceVersion };
  }

  private deviceRecord(row: RemoteDeviceDocument): RemoteDeviceRecord {
    return {
      ownerId: row.ownerId.toString(),
      deviceId: row.deviceId,
      authVersion: row.authVersion,
      deviceVersion: row.deviceVersion,
      status: row.status,
      boundAt: row.boundAt,
      operations: row.operations.map((item) => {
        return {
          operationId: item.operationId,
          expectedAuthVersion: item.expectedAuthVersion,
          expectedDeviceVersion: item.expectedDeviceVersion,
        };
      }),
      ...(row.pendingGatewayChange ? { pending: this.event(row.pendingGatewayChange) } : {}),
    };
  }
}
