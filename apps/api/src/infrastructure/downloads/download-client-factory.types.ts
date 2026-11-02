import type { QBittorrentClientPort, QBittorrentConfigStore } from '../../modules/integrations/qbittorrent.types.js';
import type { TransmissionClientPort, TransmissionConfigStore } from '../../modules/integrations/transmission.types.js';
import type { SecretCrypto } from '../../modules/integrations/secret-crypto.js';

export interface DownloadClientFactoryDependencies {
  qbittorrent: { configs: QBittorrentConfigStore; client: QBittorrentClientPort };
  transmission?: { configs: TransmissionConfigStore; client: TransmissionClientPort };
  secrets: SecretCrypto;
}
