export interface TorrentMetadataOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
