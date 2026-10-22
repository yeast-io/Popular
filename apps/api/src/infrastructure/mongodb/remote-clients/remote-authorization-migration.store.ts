import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { remoteDeviceKeyFingerprint } from './remote-authorization.schema.js';
import type { RemoteAuthorizationDocument, RemoteDeviceDocument } from './remote-authorization.schema.js';
import type { UserDocument } from '../users/user.schema.js';
import { aiStep } from '../../logging/ai-trace.js';

/** Idempotent, restartable migration. Stop old Gateway writers before deploying this storage contract.
 * Device snapshot is inserted first; users.rcck is conditionally initialized second; old authorization
 * is disabled last. No existing user/key/device fields are replaced and no plaintext can be recovered.
 */
export class MongoRemoteAuthorizationMigration {
  constructor(
    private readonly users: Model<UserDocument>,
    private readonly devices: Model<RemoteDeviceDocument>,
    private readonly legacy: Model<RemoteAuthorizationDocument>
  ) {}

  async migrate(): Promise<number> {
    let migrated = 0;
    const cursor = this.legacy
      .find({ migratedToUsers: { $ne: true } })
      .select('+keyDigest +keys')
      .lean()
      .cursor();
    for await (const row of cursor) {
      await aiStep('remote-client.migration.owner', async () => {
        const user = await this.users.findById(row.ownerId).select('+rcck').lean().exec();
        if (!user) throw new Error('Legacy RCCK owner is missing; migration stopped');
        const compatible
          = !user.rcck || (user.rcck.authVersion === row.authVersion && user.rcck.keyDigest === row.keyDigest);
        if (compatible && row.active && row.deviceId) {
          if (!row.keys) throw new Error('Legacy bound device keys are missing; migration stopped');
          await this.devices
            .updateOne(
              { deviceId: row.deviceId, ownerId: row.ownerId, authVersion: row.authVersion },
              {
                $setOnInsert: {
                  ownerId: row.ownerId,
                  deviceId: row.deviceId,
                  authVersion: row.authVersion,
                  deviceVersion: 1,
                  slot: 1,
                  status: 'bound',
                  keys: row.keys,
                  keyFingerprint: remoteDeviceKeyFingerprint(row.keys),
                  boundAt: row.boundAt ?? row.createdAt,
                  operations: [],
                },
              },
              { upsert: true, runValidators: true }
            )
            .exec();
        } else if (!compatible && row.deviceId) {
          await this.devices
            .updateOne(
              { ownerId: row.ownerId, deviceId: row.deviceId, authVersion: row.authVersion, status: 'bound' },
              { $set: { status: 'unbound', unboundAt: new Date() }, $inc: { deviceVersion: 1 } }
            )
            .exec();
        }
        await this.users
          .updateOne(
            { _id: row.ownerId, rcck: { $exists: false } },
            {
              $set: {
                rcck: {
                  keyDigest: row.keyDigest,
                  active: row.active,
                  authVersion: row.authVersion,
                  operations: (row.operations ?? []).filter((operation) => operation.kind !== 'unbind'),
                  ...(row.pendingGatewayVersion != null
                    ? {
                        pendingGatewayChange: {
                          scope: 'key',
                          eventId: row.lastOperationId ?? randomUUID(),
                          ownerId: row.ownerId.toString(),
                          authVersion: row.authVersion,
                          correlationId: row.pendingCorrelationId ?? randomUUID(),
                        },
                      }
                    : {}),
                },
              },
            },
            { runValidators: true }
          )
          .exec();
        const result = await this.legacy
          .updateOne(
            {
              _id: row._id,
              authVersion: row.authVersion,
              keyDigest: row.keyDigest,
              deviceId: row.deviceId ?? { $exists: false },
            },
            { $set: { active: false, migratedToUsers: true } }
          )
          .exec();
        if (!result.matchedCount)
          throw new Error('Legacy authorization changed during migration; stop old Gateway writers');
        migrated++;
      });
    }
    return migrated;
  }
}
