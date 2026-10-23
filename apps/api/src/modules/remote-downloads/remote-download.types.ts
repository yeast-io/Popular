import type { ResourceDownloadScope, ResourceDownloadLimit } from '../resource-sites/resource-download-limit.types.js';
import type { RemoteClientDiagnostics } from '../remote-clients/remote-client.types.js';
import type {
  CommandRecord,
  DownloadRequest,
  Session,
  Authorization,
  DeviceKeys,
  StatusPayload,
  AgentStatus,
  AgentQueueSnapshot,
  AgentQueueItem,
} from '@movie-hub/contract';

export interface RemoteDownloadSource {
  downloadId: string;
  ownerId: string;
  tmdbId: number;
  source: string;
  resourceId: string;
  remoteCommandId?: string;
  executionMode?: string;
  downloaderType?: AgentStatus['downloaderType'];
}
export interface RemoteControlStore {
  resourceDownloadLimit(scope: ResourceDownloadScope, now: number): Promise<ResourceDownloadLimit | null>;
  saveResourceDownloadLimit(limit: ResourceDownloadLimit): Promise<ResourceDownloadLimit>;
  queued(context: Session, now: number, cursor?: string): Promise<AgentQueueSnapshot>;
  authorization(keyDigest: string, deviceId?: string): Promise<Authorization | null>;
  validate(context: Session): Promise<Authorization | null>;
  bind(keyDigest: string, authVersion: number, operationId: string, keys: DeviceKeys): Promise<Authorization | null>;
  download(input: DownloadRequest): Promise<RemoteDownloadSource | null>;
  createCommand(command: CommandRecord): Promise<CommandRecord>;
  command(commandId: string): Promise<CommandRecord | null>;
  compareCommand(previous: CommandRecord, next: CommandRecord): Promise<boolean>;
  remember(key: string, digest: string): Promise<boolean>;
  purgeExpiredQueue?(now: number): Promise<void>;
  recoverCommands(): Promise<void>;
  scanCommands(filter?: RemoteCommandScan): AsyncIterable<CommandRecord>;
  projectResult(command: CommandRecord): Promise<boolean>;
  applyStatus(command: CommandRecord, status: StatusPayload): Promise<'applied' | 'stale' | 'conflict'>;
}
export interface RemoteDownloadServiceOptions {
  store: RemoteControlStore;
  torrent(command: CommandRecord, download: RemoteDownloadSource): Promise<{ url: string; torrentHash: string }>;
  diagnostics?: RemoteClientDiagnostics;
  now?: () => number;
  report(error: unknown, fields: Record<string, unknown>): void;
}

export interface RemoteCommandScan {
  deviceId?: string; pendingOnly?: boolean; retryBefore?: number;
}

export type QueuedCommandDocument = Omit<AgentQueueItem, 'reason'> & Pick<CommandRecord, 'state' | 'lastErrorCode'>;
