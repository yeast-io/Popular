import type { RemoteClientMutation, RemoteClientUnbind, RemoteAuthorizationChange } from '@movie-hub/contract';
import type { AiLogger } from '../../infrastructure/logging/ai-trace.types.js';

export type RemoteClientOperation = 'generate' | 'regenerate' | 'revoke';
export interface RemoteKeyRecord {
  ownerId: string;
  authVersion: number;
  active: boolean;
  keyDigest?: string;
  encryptedKey?: string;
  operations: Array<{ operationId: string; kind: RemoteClientOperation; expectedAuthVersion: number }>;
  pending?: RemoteAuthorizationChange;
}
export interface RemoteClientAccount {
  key: RemoteKeyRecord | null;
  deviceLimit: number;
}
export interface RemoteDeviceRecord {
  ownerId: string;
  deviceId: string;
  authVersion: number;
  deviceVersion: number;
  status: 'bound' | 'unbound';
  boundAt: Date;
  operations: Array<{ operationId: string; expectedAuthVersion: number; expectedDeviceVersion: number }>;
  pending?: RemoteAuthorizationChange;
}
export interface RemoteKeySecrets {
  keyDigest: string;
  encryptedKey: string;
}
export interface RemoteAuthorizationStore {
  account(ownerId: string): Promise<RemoteClientAccount>;
  changeKey(
    ownerId: string,
    operation: RemoteClientOperation,
    input: RemoteClientMutation,
    secrets: RemoteKeySecrets | undefined,
    event: RemoteAuthorizationChange,
  ): Promise<boolean>;
  devices(ownerId: string, authVersion: number): Promise<RemoteDeviceRecord[]>;
  device(ownerId: string, deviceId: string): Promise<RemoteDeviceRecord | null>;
  unbind(
    ownerId: string,
    deviceId: string,
    input: RemoteClientUnbind,
    event: RemoteAuthorizationChange,
  ): Promise<boolean>;
  pending(ownerId?: string): Promise<RemoteAuthorizationChange[]>;
  acknowledge(event: RemoteAuthorizationChange): Promise<void>;
}
export interface AuthorizationGateway {
  notify(event: RemoteAuthorizationChange): Promise<void>;
}
export interface RemoteClientDiagnostics {
  logger: AiLogger;
  verbose: boolean;
}
