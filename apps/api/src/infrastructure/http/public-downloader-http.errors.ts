export class DownloaderAddressError extends Error {
  readonly code = 'DOWNLOADER_ADDRESS_BLOCKED';

  constructor() {
    super('Direct downloader destination is not a public address');
    this.name = 'DownloaderAddressError';
  }
}
