import type { Locale, Provider, RuntimeStatus, SecretChange, Snapshot } from '../settings.types';
import type { DownloaderProfilesClient } from '../features/downloaders/downloader-profiles.types';
import type { ResourceSiteClient } from '../features/resource-sites/resource-sites.types';
import type { DownloadHistoryItem } from '../features/tasks/download-history.types';
import type { QueueView } from '../features/tasks/queue.types';

export type AgentPage = 'overview' | 'resource-sites' | 'downloaders' | 'tasks' | 'settings';
export interface GatewayRequest {
  gatewayUrl: string;
  locale: Locale;
  apiKey: SecretChange;
}
export interface DownloaderRequest {
  provider: Provider;
  downloaderUrl: string;
  username: string;
  authMode: 'password' | 'apiKey';
  password: SecretChange;
}
/** Business operations; implementations must never return saved credential values. */
export interface AgentClient {
  resourceSites?: ResourceSiteClient;
  downloaderProfiles?: DownloaderProfilesClient;
  getDownloadHistory?(): Promise<DownloadHistoryItem[]>;
  loadSettings(): Promise<Snapshot>;
  getRuntime(): Promise<RuntimeStatus>;
  subscribeRuntime?(receive: (status: RuntimeStatus) => void, unavailable: () => void): Promise<() => void>;
  connectGateway(request: GatewayRequest): Promise<Snapshot>;
  disconnectGateway(): Promise<void>;
  testDownloader(request: DownloaderRequest): Promise<Snapshot>;
  resetDownloader(): Promise<Snapshot>;
  saveLocale(locale: Locale): Promise<void>;
  getQueue(): Promise<QueueView>;
  setQueuePage(cursor: string | null): Promise<void>;
}
/** Optional host capabilities, separate from Agent business operations. */
export interface AgentHost {
  version: string;
  signOut?(): Promise<void>;
  openDocumentation(provider: Provider): Promise<void>;
  setTitle?(title: string): Promise<void>;
  setAutostart?(enabled: boolean): Promise<void>;
  onNavigate?(handler: (page: AgentPage) => void): Promise<() => void>;
}
export interface AgentRootProps {
  client: AgentClient;
  host: AgentHost;
}

export type { ResourceSite, ResourceSiteSnapshot, ResourceSiteRequest, ResourceSiteClient } from '../features/resource-sites/resource-sites.types';
