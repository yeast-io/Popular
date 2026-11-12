import type { DownloaderRequest } from '../../transport/agent-transport.types';
import type { Snapshot } from '../../settings.types';

export interface DownloaderProfile extends Omit<DownloaderRequest, 'password'> {
  id: string;
  enabled: boolean;
  isDefault: boolean;
  hasPassword: boolean;
}
export interface DownloaderProfileAction {
  id: string;
  operation: 'default' | 'enabled' | 'remove';
  enabled?: boolean;
}
export interface DownloaderProfilesClient {
  list(): Promise<DownloaderProfile[]>;
  configure(request: { id: string | null; configuration: DownloaderRequest }): Promise<Snapshot>;
  action(request: DownloaderProfileAction): Promise<Snapshot>;
}
