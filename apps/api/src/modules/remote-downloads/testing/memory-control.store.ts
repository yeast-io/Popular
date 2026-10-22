// TEST DOUBLE ONLY. Production uses MongoRemoteControlStore; this is not evidence of MongoDB behavior.
import { randomUUID } from 'node:crypto';
import type {
  Authorization,
  Session,
  DeviceKeys,
  DownloadRequest,
  CommandRecord,
  StatusPayload,
} from '@movie-hub/contract';
import type { RemoteControlStore } from '../remote-download.types.js';
import type { FixtureDownload, FixtureDevice } from './memory-control.types.js';
import { ensure, fingerprint } from '../remote-download.domain.js';

export class MemoryControlStore implements RemoteControlStore {
  readonly accounts = new Map<string, Authorization>();
  readonly devices = new Map<string, FixtureDevice>();
  readonly limits = new Map<string, number>();
  readonly downloads = new Map<string, FixtureDownload>();
  readonly commands = new Map<string, CommandRecord>();
  readonly receipts = new Map<string, string>();

  async authorization(digest: string, deviceId?: string) {
    const a = [...this.accounts.values()].find((a) => a.keyDigest === digest && a.active);
    if (!a) return null;
    if (!deviceId) return structuredClone(a);
    const d = this.devices.get(deviceId);
    return d?.ownerId === a.ownerId && d.authVersion === a.authVersion && d.status === 'bound'
      ? structuredClone({ ...a, deviceId, deviceVersion: d.deviceVersion!, keys: d.keys! })
      : null;
  }

  async validate(s: Session) {
    const a = this.accounts.get(s.ownerId);
    if (!a?.active || a.authVersion !== s.authVersion) return null;
    const d = await this.authorization(a.keyDigest, s.deviceId);
    return d?.deviceVersion === s.deviceVersion ? d : null;
  }

  async bind(digest: string, authVersion: number, operationId: string, keys: DeviceKeys) {
    const a = await this.authorization(digest);
    ensure(a?.authVersion === authVersion, 'INVALID_API_KEY');
    const bindingDigest = fingerprint({ authVersion, keys });
    ensure(await this.remember(`bind:${a.ownerId}:${operationId}`, bindingDigest), 'IDEMPOTENCY_CONFLICT');
    const bound = [...this.devices.values()].filter((d) => {
      return d.ownerId === a.ownerId && d.authVersion === authVersion && d.status === 'bound';
    });
    const old = [...this.devices.values()].find((d) => d.ownerId === a.ownerId && d.bindingOperationId === operationId);
    if (old) {
      ensure(old.status === 'bound', 'DEVICE_BINDING_REJECTED');
      return this.authorization(digest, old.deviceId);
    }
    const same = bound.find((d) => {
      return fingerprint(d.keys) === fingerprint(keys);
    });
    if (same) return this.authorization(digest, same.deviceId);
    ensure(bound.length < (this.limits.get(a.ownerId) ?? 1), 'DEVICE_LIMIT_REACHED');
    const id = randomUUID();
    this.devices.set(id, {
      ...a,
      deviceId: id,
      deviceVersion: 1,
      keys,
      status: 'bound',
      bindingOperationId: operationId,
    });
    return this.authorization(digest, id);
  }

  async download(input: DownloadRequest) {
    const d = this.downloads.get(input.downloadId);
    return d
      && d.ownerId === input.ownerId
      && d.source === input.source
      && d.resourceId === input.resourceId
      && (!d.intent || d.intent.commandId === input.commandId)
      ? {
          downloadId: d.downloadId,
          ownerId: d.ownerId,
          tmdbId: d.tmdbId,
          source: d.source,
          resourceId: d.resourceId,
          executionMode: d.executionMode,
          downloaderType: d.downloaderType ?? 'qbittorrent',
        }
      : null;
  }

  async createCommand(c: CommandRecord) {
    const old = this.commands.get(c.commandId);
    if (old) return structuredClone(old);
    const d = this.downloads.get(c.downloadId);
    ensure(d, 'DOWNLOAD_OWNERSHIP_MISMATCH');
    if (d.intent) ensure(d.intent.digest === c.digest, 'IDEMPOTENCY_CONFLICT');
    else d.intent = structuredClone(c);
    this.commands.set(c.commandId, structuredClone(d.intent));
    return structuredClone(d.intent);
  }

  async command(id: string) {
    return structuredClone(this.commands.get(id) ?? null);
  }

  async compareCommand(previous: CommandRecord, next: CommandRecord) {
    if (this.commands.get(previous.commandId)?.revision !== previous.revision) return false;
    this.commands.set(previous.commandId, structuredClone(next));
    return true;
  }

  async remember(key: string, digest: string) {
    const old = this.receipts.get(key);
    if (old) return old === digest;
    this.receipts.set(key, digest);
    return true;
  }

  async recoverCommands() {
    for (const d of this.downloads.values())
      if (d.intent && !this.commands.has(d.intent.commandId)) await this.createCommand(d.intent);
  }

  async* scanCommands(filter: { deviceId?: string; pendingOnly?: boolean } = {}) {
    for (const c of [...this.commands.values()]) {
      if (filter.deviceId && c.deviceId !== filter.deviceId) continue;
      if (filter.pendingOnly && c.projected && !['accepted', 'delivered', 'received', 'granted'].includes(c.state))
        continue;
      yield structuredClone(c);
    }
  }

  async projectResult(c: CommandRecord) {
    const d = this.downloads.get(c.downloadId);
    if (
      !d
      || d.ownerId !== c.ownerId
      || d.commandId !== c.commandId
      || d.deviceId !== c.deviceId
      || d.deviceVersion !== c.deviceVersion
    )
      return false;
    if ((d.projectedRevision ?? -1) >= c.revision) return true;
    if (c.result?.outcome === 'succeeded') {
      if (d.association && fingerprint(d.association.result?.evidence) !== fingerprint(c.result.evidence)) return false;
      d.association = structuredClone(c);
    }
    if (c.result && d.result?.outcome !== 'succeeded') d.result = structuredClone(c.result);
    d.projectedRevision = c.revision;
    d.requestState = c.state;
    return true;
  }

  async applyStatus(c: CommandRecord, status: StatusPayload) {
    const d = this.downloads.get(c.downloadId);
    if (
      !d?.association
      || d.association.executionId !== status.executionId
      || fingerprint(d.association.result?.evidence) !== fingerprint(status.evidence)
    )
      return 'conflict' as const;
    if ((d.status?.sequence ?? 0) >= status.sequence) return 'stale' as const;
    d.status = structuredClone(status);
    return 'applied' as const;
  }
}
