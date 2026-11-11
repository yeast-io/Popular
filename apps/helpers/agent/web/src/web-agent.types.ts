import type { AgentClient } from '@movie-hub/helper-agent-ui/transport';

export interface ManagementSession {
  authenticated: boolean;
  csrf?: string;
  version: string;
}
export interface WebAgentOptions {
  onSessionExpired(): void;
}
export interface WebAgentClient {
  client: AgentClient;
  session(): Promise<ManagementSession>;
  login(password: string): Promise<ManagementSession>;
  logout(): Promise<void>;
  close(): void;
}
