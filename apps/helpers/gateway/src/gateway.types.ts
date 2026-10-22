import type { JWK, CryptoKey } from 'jose';
import type { Logger } from 'pino';
import type { RpcCaller, SocketRpc, RpcFrame } from '@movie-hub/contract/socket-rpc';
import type { Session, AgentStatus, DeviceKeys, WireMessage } from '@movie-hub/contract';

export type {
  Session,
  AgentStatus,
  DeviceKeys,
  WireMessage,
  Authorization,
  DownloadRequest,
  CommandRecord,
  CommandState,
  ResultPayload,
  StatusPayload,
  TaskEvidence,
} from '@movie-hub/contract';
export interface Route extends Session {
  status?: AgentStatus;
}
export interface Router {
  claim(session: Session): Promise<void>;
  get(deviceId: string): Promise<Route | null>;
  renew(session: Session, status?: AgentStatus): Promise<boolean>;
  release(session: Session): Promise<void>;
  wake(deviceId: string): Promise<void>;
  subscribe(handler: (deviceId: string) => void): Promise<void>;
  rateLimit(key: string, limit: number, windowMs: number): Promise<boolean>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
export interface Peer {
  id: string;
  digest: string;
  session?: Session;
  status?: AgentStatus;
  handshake?: Map<string, { digest: string; response: WireMessage }>;
  challenge?: {
    text: string;
    keys: DeviceKeys;
    expiresAt: number;
    authVersion: number;
    deviceId?: string;
    operationId?: string;
  };
  send(message: WireMessage): void;
  close(code: number): void;
}
export interface SigningIdentity {
  kid: string;
  privateKey: CryptoKey;
  publicKey: JWK;
}
export interface GatewayBus {
  instances(serviceOnly?: boolean): Promise<string[]>;
  call<T>(target: string, kind: 'popular' | 'gateway', frame: RpcFrame): Promise<T>;
  available(value: boolean): Promise<void>;
  start(handler: (kind: 'popular' | 'gateway', frame: RpcFrame) => Promise<unknown>): Promise<void>;
  close(): Promise<void>;
}
export interface GatewayOptions {
  instanceId: string;
  router: Router;
  popular: RpcCaller;
  signing: SigningIdentity;
  logger: Logger;
  verbose: boolean;
  bus?: GatewayBus;
  now?: () => number;
}
export interface ServicePeer {
  rpc: SocketRpc;
  ready: boolean;
}
export interface RelayPending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export interface RelayRequest {
  id: string;
  source: string;
  kind: 'popular' | 'gateway';
  expiresAt: number;
  frame: RpcFrame;
}
