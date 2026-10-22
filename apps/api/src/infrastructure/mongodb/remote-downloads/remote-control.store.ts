import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import type {
  CommandRecord,
  DownloadRequest,
  Session,
  Authorization,
  DeviceKeys,
  StatusPayload,
} from '@movie-hub/contract';
import { RpcError } from '@movie-hub/contract/socket-rpc';
import type { UserDocument } from '../users/user.schema.js';
import type { RemoteDeviceDocument } from '../remote-clients/remote-device.schema.js';
import type { MovieDownloadDocument } from '../downloads/movie-download.schema.js';
import { remoteDeviceKeyFingerprint } from '../remote-clients/remote-device.domain.js';
import type { RemoteControlStore } from '../../../modules/remote-downloads/remote-download.types.js';
import type { RemoteCommandModels } from './remote-command.schema.js';
import { canonical, ensure, fingerprint } from '../../../modules/remote-downloads/remote-download.domain.js';

export class MongoRemoteControlStore implements RemoteControlStore {
  constructor(
    readonly users: Model<UserDocument>,
    readonly devices: Model<RemoteDeviceDocument>,
    readonly downloads: Model<MovieDownloadDocument>,
    readonly models: RemoteCommandModels
  ) {}

  async authorization(keyDigest: string, deviceId?: string): Promise<Authorization | null> {
    const user = await this.users
      .findOne({ 'rcck.keyDigest': keyDigest, 'rcck.active': true })
      .select('+rcck')
      .lean()
      .exec();
    if (!user?.rcck) return null;
    const a: Authorization = {
      ownerId: user._id.toString(),
      keyDigest,
      authVersion: user.rcck.authVersion,
      active: true,
    };
    if (!deviceId) return a;
    const device = await this.devices
      .findOne({ ownerId: user._id, deviceId, authVersion: a.authVersion, status: 'bound' })
      .select('+keys')
      .lean()
      .exec();
    if (!device) return null;
    return {
      ...a,
      deviceId,
      deviceVersion: device.deviceVersion,
      keys: JSON.parse(JSON.stringify(device.keys)) as DeviceKeys,
    };
  }

  async validate(context: Session) {
    if (!Types.ObjectId.isValid(context.ownerId)) return null;
    const user = await this.users
      .findOne({ '_id': context.ownerId, 'rcck.authVersion': context.authVersion, 'rcck.active': true })
      .select('+rcck')
      .lean()
      .exec();
    if (!user?.rcck?.keyDigest) return null;
    const a = await this.authorization(user.rcck.keyDigest, context.deviceId);
    return a?.deviceVersion === context.deviceVersion && a.ownerId === context.ownerId ? a : null;
  }

  async bind(keyDigest: string, authVersion: number, operationId: string, keys: DeviceKeys) {
    const a = await this.authorization(keyDigest);
    ensure(a?.authVersion === authVersion, 'INVALID_API_KEY');
    const keyFingerprint = remoteDeviceKeyFingerprint(keys);
    const bindingDigest = fingerprint({ authVersion, keys });
    const old = await this.devices.findOne({ ownerId: a.ownerId, bindingOperationId: operationId }).lean().exec();
    if (old) {
      ensure(
        old.bindingDigest === bindingDigest && old.authVersion === authVersion && old.status === 'bound',
        'IDEMPOTENCY_CONFLICT'
      );
      return this.authorization(keyDigest, old.deviceId);
    }
    const same = await this.devices
      .findOne({ ownerId: a.ownerId, authVersion, keyFingerprint, status: 'bound' })
      .lean()
      .exec();
    if (same) return this.authorization(keyDigest, same.deviceId);
    const user = await this.users.findById(a.ownerId).select('remoteDeviceLimit').lean().exec();
    for (let slot = 1; slot <= (user?.remoteDeviceLimit ?? 1); slot++) {
      try {
        const created = await this.devices.create({
          ownerId: a.ownerId,
          deviceId: randomUUID(),
          authVersion,
          deviceVersion: 1,
          slot,
          status: 'bound',
          keys,
          keyFingerprint,
          bindingOperationId: operationId,
          bindingDigest,
          boundAt: new Date(),
        });
        return this.authorization(keyDigest, created.deviceId);
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        const found = await this.devices
          .findOne({ ownerId: a.ownerId, authVersion, keyFingerprint, status: 'bound' })
          .lean()
          .exec();
        if (found) return this.authorization(keyDigest, found.deviceId);
        const operation = await this.devices
          .findOne({ ownerId: a.ownerId, bindingOperationId: operationId })
          .lean()
          .exec();
        if (operation) {
          ensure(operation.bindingDigest === bindingDigest, 'IDEMPOTENCY_CONFLICT');
          return this.authorization(keyDigest, operation.deviceId);
        }
      }
    }
    throw new RpcError('DEVICE_LIMIT_REACHED', 'not_applied');
  }

  async download(input: DownloadRequest) {
    if (!Types.ObjectId.isValid(input.downloadId) || !Types.ObjectId.isValid(input.ownerId)) return null;
    const row = await this.downloads
      .findOne({
        _id: input.downloadId,
        ownerId: input.ownerId,
        sourceProvider: input.source,
        sourceReleaseId: input.resourceId,
        executionMode: 'remote',
        $or: [{ 'remoteRequest.commandId': input.commandId }, { remoteRequest: { $exists: false } }],
      })
      .lean()
      .exec();
    return row
      ? {
          downloadId: input.downloadId,
          ownerId: input.ownerId,
          tmdbId: row.tmdbId,
          source: row.sourceProvider,
          resourceId: row.sourceReleaseId,
          executionMode: 'remote',
          downloaderType: row.provider,
          ...(row.remoteRequest?.commandId ? { remoteCommandId: row.remoteRequest.commandId } : {}),
        }
      : null;
  }

  async createCommand(c: CommandRecord) {
    const old = await this.command(c.commandId);
    if (old) {
      await this.registered(old);
      return old;
    }
    const intent = {
      commandId: c.commandId,
      deviceId: c.deviceId,
      authVersion: c.authVersion,
      deviceVersion: c.deviceVersion,
      source: c.source,
      resourceId: c.resourceId,
      correlationId: c.correlationId,
      digest: c.digest,
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      deliverySessionId: c.deliverySessionId,
      deliveryMessageId: c.deliveryMessageId,
    };
    await this.downloads
      .updateOne(
        {
          _id: c.downloadId,
          ownerId: c.ownerId,
          executionMode: 'remote',
          remoteRequest: { $exists: false },
          sourceProvider: c.source,
          sourceReleaseId: c.resourceId,
        },
        { $set: { remoteRequest: intent, remoteRequestState: 'accepted' } }
      )
      .exec();
    const row = await this.downloads
      .findOne({ '_id': c.downloadId, 'ownerId': c.ownerId, 'remoteRequest.commandId': c.commandId })
      .lean()
      .exec();
    ensure(row?.remoteRequest && row.remoteRequest.digest === c.digest, 'IDEMPOTENCY_CONFLICT');
    const stable: CommandRecord = {
      ...c,
      createdAt: row.remoteRequest.createdAt!,
      expiresAt: row.remoteRequest.expiresAt!,
      deliverySessionId: row.remoteRequest.deliverySessionId!,
      deliveryMessageId: row.remoteRequest.deliveryMessageId!,
    };
    try {
      const created = plain(await this.models.commands.create(stable));
      await this.registered(created);
      return created;
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const found = await this.command(c.commandId);
      ensure(found, 'IDEMPOTENCY_CONFLICT');
      await this.registered(found);
      return found;
    }
  }

  private async registered(c: CommandRecord) {
    await this.downloads
      .updateOne(
        { '_id': c.downloadId, 'ownerId': c.ownerId, 'remoteRequest.commandId': c.commandId },
        { $set: { remoteCommandRegistered: true } }
      )
      .exec();
  }

  async recoverCommands() {
    for await (const row of this.downloads
      .find({ executionMode: 'remote', remoteRequest: { $exists: true }, remoteCommandRegistered: { $ne: true } })
      .lean()
      .cursor()) {
      const intent = row.remoteRequest!;
      ensure(
        intent.commandId
        && intent.deviceId
        && intent.authVersion
        && intent.deviceVersion
        && intent.source
        && intent.resourceId
        && intent.correlationId
        && intent.digest
        && intent.createdAt
        && intent.expiresAt
        && intent.deliverySessionId
        && intent.deliveryMessageId,
        'INVALID_DOWNLOAD_INTENT'
      );
      const input: DownloadRequest = {
        commandId: intent.commandId,
        downloadId: row._id.toString(),
        ownerId: row.ownerId.toString(),
        deviceId: intent.deviceId,
        authVersion: intent.authVersion,
        deviceVersion: intent.deviceVersion,
        source: intent.source,
        resourceId: intent.resourceId,
        correlationId: intent.correlationId,
      };
      ensure(
        fingerprint(input) === intent.digest
        && row.sourceProvider === input.source
        && row.sourceReleaseId === input.resourceId,
        'INVALID_DOWNLOAD_INTENT'
      );
      await this.createCommand({
        ...input,
        digest: intent.digest,
        createdAt: intent.createdAt,
        expiresAt: intent.expiresAt,
        deliverySessionId: intent.deliverySessionId,
        deliveryMessageId: intent.deliveryMessageId,
        revision: 0,
        state: 'accepted',
      });
    }
  }

  async command(commandId: string) {
    const row = await this.models.commands.findOne({ commandId }).lean().exec();
    return row ? plain(row) : null;
  }

  async compareCommand(previous: CommandRecord, next: CommandRecord) {
    const result = await this.models.commands
      .updateOne({ commandId: previous.commandId, revision: previous.revision }, { $set: next })
      .exec();
    return result.modifiedCount === 1;
  }

  async remember(key: string, digest: string) {
    try {
      await this.models.receipts.create({ key, digest });
      return true;
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const row = await this.models.receipts.findOne({ key }).lean().exec();
      return row?.digest === digest;
    }
  }

  async* scanCommands(filter: { deviceId?: string; pendingOnly?: boolean } = {}) {
    const query = {
      ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
      ...(filter.pendingOnly
        ? {
            $or: [{ state: { $in: ['accepted', 'delivered', 'received', 'granted'] } }, { projected: { $ne: true } }],
          }
        : {}),
    };
    for await (const row of this.models.commands.find(query).lean().cursor()) yield plain(row);
  }

  private filter(c: CommandRecord) {
    return {
      '_id': c.downloadId,
      'ownerId': c.ownerId,
      'executionMode': 'remote',
      'remoteRequest.commandId': c.commandId,
      'remoteRequest.deviceId': c.deviceId,
      'remoteRequest.authVersion': c.authVersion,
      'remoteRequest.deviceVersion': c.deviceVersion,
    };
  }

  async projectResult(c: CommandRecord) {
    const filter = this.filter(c);
    const row = await this.downloads.findOne(filter).lean().exec();
    if (!row) return false;
    if ((row.remoteProjectionRevision ?? -1) >= c.revision) return true;
    const update: Record<string, unknown> = { remoteRequestState: c.state, remoteProjectionRevision: c.revision };
    if (c.result) {
      if (row.remoteOutcome !== 'succeeded') update.remoteOutcome = c.result.outcome;
      if (c.result.outcome === 'succeeded') {
        const e = c.result.evidence!;
        const association = {
          ...e,
          commandId: c.commandId,
          executionId: c.executionId!,
          deviceId: c.deviceId,
          authVersion: c.authVersion,
          deviceVersion: c.deviceVersion,
        };
        if (row.remoteAssociation && canonical(row.remoteAssociation) !== canonical(association)) return false;
        update.remoteAssociation = association;
        update.torrentHash = e.torrentHash;
        if (!row.remoteAssociation) {
          update.status = 'downloading';
          update.progress = 0;
          update.addedAt = new Date();
        }
      } else if (!row.remoteAssociation) {
        if (c.result.outcome === 'unknown') update.lastErrorCode = 'DOWNLOAD_EXECUTION_UNKNOWN';
        else {
          update.status = 'failed';
          update.lastErrorCode = c.result.outcome === 'duplicate' ? 'DOWNLOAD_DUPLICATE' : 'MOVIE_DOWNLOAD_FAILED';
        }
      }
    } else if (['expired', 'cancelled', 'closed'].includes(c.state) && !c.executionId && !row.remoteAssociation) {
      update.status = 'failed';
      update.lastErrorCode = 'DOWNLOAD_REQUEST_CLOSED';
    }
    await this.downloads
      .updateOne(
        {
          ...filter,
          $or: [{ remoteProjectionRevision: { $exists: false } }, { remoteProjectionRevision: { $lt: c.revision } }],
        },
        { $set: update }
      )
      .exec();
    return true;
  }

  async applyStatus(c: CommandRecord, status: StatusPayload) {
    const e = status.evidence;
    const filter = {
      ...this.filter(c),
      'remoteAssociation.commandId': c.commandId,
      'remoteAssociation.executionId': status.executionId,
      'remoteAssociation.deviceId': c.deviceId,
      'remoteAssociation.authVersion': c.authVersion,
      'remoteAssociation.deviceVersion': c.deviceVersion,
      'remoteAssociation.instanceId': e.instanceId,
      'remoteAssociation.downloaderType': e.downloaderType,
      'remoteAssociation.torrentHash': e.torrentHash,
      'remoteAssociation.taskId': e.taskId,
      'remoteAssociation.marker': e.marker,
    };
    const row = await this.downloads.findOne(filter).select('remoteStatusSequence status').lean().exec();
    if (!row) return 'conflict' as const;
    if ((row.remoteStatusSequence ?? 0) >= status.sequence) return 'stale' as const;
    const state = status.state === 'deleted' ? 'missing' : status.state === 'unreachable' ? undefined : status.state;
    const update: Record<string, unknown> = {
      remoteStatusSequence: status.sequence,
      remoteStatusState: status.state,
      progress: status.progress * 100,
      downloadedBytes: status.downloadedBytes,
      totalBytes: status.totalBytes,
      downloadSpeed: status.downloadSpeed,
      lastSyncedAt: new Date(),
      ...(state ? { status: state } : {}),
      lastErrorCode:
        status.state === 'unreachable'
          ? 'DOWNLOADER_UNREACHABLE'
          : status.state === 'deleted'
            ? 'DOWNLOAD_TORRENT_MISSING'
            : '',
    };
    const result = await this.downloads
      .updateOne(
        {
          ...filter,
          $or: [{ remoteStatusSequence: { $exists: false } }, { remoteStatusSequence: { $lt: status.sequence } }],
        },
        { $set: update }
      )
      .exec();
    return result.modifiedCount ? ('applied' as const) : ('stale' as const);
  }
}
function isDuplicate(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 11000;
}
function plain(value: unknown): CommandRecord {
  const { _id: _id, __v: _version, ...record } = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return record as unknown as CommandRecord;
}
