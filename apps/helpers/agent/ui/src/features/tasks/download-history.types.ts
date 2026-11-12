import type { Provider } from '../../settings.types';

export interface DownloadHistoryItem {
  downloadId: string;
  executionId: string;
  provider: Provider;
  phase: string;
  state: string | null;
  progress: number | null;
}
