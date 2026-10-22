import type { IntegrationFailureType, QBittorrentAuthMethod } from '@movie-hub/contract';

export type QBittorrentCredential
  = { authMethod: 'api_key'; apiKey: string } | { authMethod: 'username_password'; username: string; password: string };

export interface QBittorrentConfigRecord {
  ownerId: string;
  baseUrl: string;
  authMethod: QBittorrentAuthMethod;
  username?: string;
  encryptedCredential: string;
  version?: string;
  verifiedAt?: Date;
  lastValidationAt?: Date;
  lastFailureType?: IntegrationFailureType;
}

export interface QBittorrentConfigStore {
  find(ownerId: string): Promise<QBittorrentConfigRecord | null>;
  saveVerified(
    input: QBittorrentConfigRecord & { verifiedAt: Date; lastValidationAt: Date },
  ): Promise<QBittorrentConfigRecord>;
  recordFailure(ownerId: string, attemptedAt: Date, failureType: IntegrationFailureType): Promise<void>;
  delete(ownerId: string): Promise<void>;
}

export interface QBittorrentTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number;
  etaSeconds: number;
  tags: string[];
}

export interface QBittorrentClientPort {
  verify(baseUrl: string, credential: QBittorrentCredential): Promise<{ version: string }>;
  addTorrent(baseUrl: string, credential: QBittorrentCredential, torrentUrl: string, tag: string): Promise<void>;
  listTorrents(baseUrl: string, credential: QBittorrentCredential, hashes?: string[]): Promise<QBittorrentTorrent[]>;
  findByTag(baseUrl: string, credential: QBittorrentCredential, tag: string): Promise<QBittorrentTorrent | null>;
}
