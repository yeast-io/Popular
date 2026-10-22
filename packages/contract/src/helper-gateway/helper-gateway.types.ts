export interface DeviceKeys {
  signingKey: { kty: string; crv?: string; x?: string; n?: string; e?: string };
  encryptionKey: { kty: string; crv?: string; x?: string; n?: string; e?: string };
}
export interface Authorization {
  ownerId: string; keyDigest: string; authVersion: number; active: boolean;
  deviceId?: string; deviceVersion?: number; keys?: DeviceKeys;
}
export interface Session {
  ownerId: string; deviceId: string; authVersion: number; deviceVersion: number;
  sessionId: string; instanceId: string;
}
export interface AgentStatus {
  downloaderType: 'qbittorrent' | 'transmission'; instanceId: string; configured: boolean; reachable: boolean;
}
export interface DownloadRequest {
  commandId: string; downloadId: string; ownerId: string; deviceId: string; authVersion: number;
  deviceVersion: number; source: string; resourceId: string; correlationId: string;
}
export type CommandState = 'accepted' | 'delivered' | 'received' | 'granted' | 'succeeded'
  | 'duplicate' | 'failed' | 'unknown' | 'closed' | 'expired' | 'cancelled';
export interface TaskEvidence {
  downloaderType: 'qbittorrent' | 'transmission'; instanceId: string; torrentHash: string; taskId: string; marker: string;
}
export interface ResultPayload {
  commandId: string; executionId: string; outcome: 'succeeded' | 'duplicate' | 'failed' | 'unknown'; evidence?: TaskEvidence | undefined;
}
export interface StatusPayload {
  commandId: string; executionId: string; sequence: number; evidence: TaskEvidence;
  state: 'downloading' | 'completed' | 'paused' | 'failed' | 'unreachable' | 'deleted';
  progress: number; downloadedBytes: number; totalBytes: number; downloadSpeed: number; uploadSpeed: number;
}
export interface CommandRecord extends DownloadRequest {
  revision: number; digest: string; state: CommandState; createdAt: number; expiresAt: number;
  deliverySessionId: string; deliveryMessageId: string; envelope?: string; torrentHash?: string;
  executionId?: string; grantSessionId?: string; grantExpiresAt?: number;
  executionDownloader?: { downloaderType: AgentStatus['downloaderType']; instanceId: string };
  result?: ResultPayload; resultDigest?: string; projected?: boolean; closeId?: string;
}
export interface PreparedDelivery {
  command: CommandRecord; keys: DeviceKeys; torrent?: { url: string; torrentHash: string };
}
export interface PublicCommand {
  commandId: string; downloadId: string; state: CommandState; expiresAt: number;
  executionId?: string | undefined; grantExpiresAt?: number | undefined; result?: ResultPayload | undefined;
  accepted: true; added: boolean | null;
}
export interface WireMessage {
  protocolVersion: 1; command: string; messageId: string; replyTo?: string; correlationId?: string; payload: unknown;
}
