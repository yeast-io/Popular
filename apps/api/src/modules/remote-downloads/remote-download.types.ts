import type {
  CommandRecord,
  DownloadRequest,
  Session,
  Authorization,
  DeviceKeys,
  StatusPayload,
  AgentStatus,
} from '@movie-hub/contract';

export interface RemoteDownloadSource {
  downloadId: string;
  ownerId: string;
  tmdbId: number;
  source: string;
  resourceId: string;
  remoteCommandId?: string;
  executionMode?: string;
  downloaderType: AgentStatus['downloaderType'];
}
export interface RemoteControlStore {
  authorization(keyDigest: string, deviceId?: string): Promise<Authorization | null>;
  validate(context: Session): Promise<Authorization | null>;
  bind(keyDigest: string, authVersion: number, operationId: string, keys: DeviceKeys): Promise<Authorization | null>;
  download(input: DownloadRequest): Promise<RemoteDownloadSource | null>;
  createCommand(command: CommandRecord): Promise<CommandRecord>;
  command(commandId: string): Promise<CommandRecord | null>;
  compareCommand(previous: CommandRecord, next: CommandRecord): Promise<boolean>;
  remember(key: string, digest: string): Promise<boolean>;
  recoverCommands(): Promise<void>;
  scanCommands(filter?: { deviceId?: string; pendingOnly?: boolean }): AsyncIterable<CommandRecord>;
  projectResult(command: CommandRecord): Promise<boolean>;
  applyStatus(command: CommandRecord, status: StatusPayload): Promise<'applied' | 'stale' | 'conflict'>;
}
export interface RemoteDownloadServiceOptions {
  store: RemoteControlStore;
  torrent(command: CommandRecord, download: RemoteDownloadSource): Promise<{ url: string; torrentHash: string }>;
  now?: () => number;
  report(error: unknown, fields: Record<string, unknown>): void;
}
