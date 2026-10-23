export interface ResourceDownloadScope {
  ownerId: string;
  source: string;
  resourceId: string;
}
export interface ResourceDownloadLimit extends ResourceDownloadScope {
  kind: 'torrent_daily_limit';
  detectedAt: number;
  retryAt: number;
}
