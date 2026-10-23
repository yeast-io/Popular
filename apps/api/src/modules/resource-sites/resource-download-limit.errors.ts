import { RpcError } from '@movie-hub/contract/socket-rpc';
import { RESOURCE_TORRENT_DAILY_LIMIT } from './resource-download-limit.policy.js';

export class ResourceDownloadLimitError extends RpcError {
  constructor(options?: ErrorOptions) {
    super(RESOURCE_TORRENT_DAILY_LIMIT, 'not_applied', options);
  }
}
