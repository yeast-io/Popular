export interface RpcFrame {
  protocolVersion: 1; command: string; messageId: string; replyTo?: string; correlationId: string; payload: unknown;
}
export interface RpcTransport {
  send(text: string): void; close(): void; open(): boolean; bufferedBytes(): number;
  onMessage(handler: (text: string) => void): void; onClose(handler: () => void): void;
}
export interface RpcDiagnostics {
  verbose: boolean;
  info(fields: Record<string, unknown>): void;
  error(error: unknown, fields: Record<string, unknown>): void;
}
export interface RpcOptions {
  transport: RpcTransport; allowed: readonly string[];
  handle(command: string, payload: unknown, frame: RpcFrame): Promise<unknown>;
  diagnostics: RpcDiagnostics; timeoutMs?: number; maxInFlight?: number; maxBufferedBytes?: number;
}
export interface RpcPending {
  resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; command: string; correlationId: string;
}
export interface RpcCaller {
  call<T = unknown>(command: string, payload: unknown, correlationId?: string, messageId?: string): Promise<T>;
}
