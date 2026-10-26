import type { SocketRpc, RpcDiagnostics, RpcFrame } from '@movie-hub/contract/socket-rpc';
import type WebSocket from 'ws';

export interface GatewayPoolOptions {
  urls: string[];
  token: string;
  instanceId: string;
  size?: number;
  diagnostics: RpcDiagnostics;
  handle(command: string, payload: unknown, frame: RpcFrame): Promise<unknown>;
}
export interface GatewayPoolMember {
  slot: number;
  attempt: number;
  socket?: WebSocket;
  rpc?: SocketRpc;
  ready: boolean;
  timer?: ReturnType<typeof setTimeout>;
  ping?: ReturnType<typeof setInterval>;
}
