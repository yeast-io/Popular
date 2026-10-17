import type { IntegrationFailureType } from '@movie-hub/contract';

export interface TransmissionCredential {
  username: string;
  password: string;
}

export interface TransmissionConfigRecord {
  ownerId: string;
  baseUrl: string;
  username: string;
  encryptedCredential: string;
  version?: string;
  verifiedAt?: Date;
  lastValidationAt?: Date;
  lastFailureType?: IntegrationFailureType;
}

export interface TransmissionConfigStore {
  find(ownerId: string): Promise<TransmissionConfigRecord | null>;
  saveVerified(input: TransmissionConfigRecord & { verifiedAt: Date; lastValidationAt: Date }): Promise<TransmissionConfigRecord>;
  recordFailure(ownerId: string, attemptedAt: Date, failureType: IntegrationFailureType): Promise<void>;
  delete(ownerId: string): Promise<void>;
}

export interface TransmissionClientPort {
  verify(baseUrl: string, credential: TransmissionCredential): Promise<{ version: string }>;
  addTorrent(baseUrl: string, credential: TransmissionCredential, torrent: Uint8Array, tag: string): Promise<string>;
  listTorrents(baseUrl: string, credential: TransmissionCredential, hashes?: string[]): Promise<TransmissionTorrent[]>;
  findByTag(baseUrl: string, credential: TransmissionCredential, tag: string): Promise<TransmissionTorrent | null>;
}

export interface TransmissionTorrent {
  hash: string;
  name: string;
  status: number;
  error: number;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number;
  etaSeconds: number;
  labels: string[];
}
