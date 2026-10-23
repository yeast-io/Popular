export interface TorrentMetadataOptions {
  source?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
