import type { CommandRecord, DownloadRequest, ResultPayload, StatusPayload, Authorization } from '@movie-hub/contract';

export interface FixtureDownload extends DownloadRequest {
  tmdbId: number;
  executionMode: 'remote';
  downloaderType?: 'qbittorrent' | 'transmission';
  intent?: CommandRecord;
  result?: ResultPayload;
  association?: CommandRecord;
  status?: StatusPayload;
  projectedRevision?: number;
  requestState?: string;
  notificationTasks: string[];
}
export interface FixtureDevice extends Authorization {
  status: 'bound' | 'unbound';
  bindingOperationId: string;
}
