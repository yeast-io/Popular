import type { DownloadProvider, DownloaderChoice, Locale } from '@movie-hub/contract';
import type {
  DownloadClient, DownloadClientFactory,
} from '../../modules/downloads/movie-download-client.types.js';
import type { DownloadClientFactoryDependencies } from './download-client-factory.types.js';
import { downloadClientMessages } from '../../modules/downloads/download-client.messages.js';
import { decryptCredential, normalizeQBittorrentBaseUrl } from '../../modules/integrations/qbittorrent-integration.service.js';
import {
  decryptCredential as decryptTransmissionCredential,
  normalizeTransmissionBaseUrl,
} from '../../modules/integrations/transmission-integration.service.js';
import { AppError } from '../http/app-error.js';
import { aiStep } from '../logging/ai-trace.js';
import { QBittorrentDownloadAdapter } from '../qbittorrent/qbittorrent-download.adapter.js';
import { TransmissionDownloadAdapter } from '../transmission/transmission-download.adapter.js';

export class ConfiguredDownloadClientFactory implements DownloadClientFactory {
  constructor(private readonly dependencies: DownloadClientFactoryDependencies) {}

  async instancesFor(ownerId: string): Promise<DownloaderChoice[]> {
    const { qbittorrent, transmission } = this.dependencies;
    const [qb, tr] = await Promise.all([
      qbittorrent.configs.list?.(ownerId) ?? qbittorrent.configs.find(ownerId).then((record) => record ? [record] : []),
      transmission?.configs.list?.(ownerId) ?? transmission?.configs.find(ownerId).then((record) => record ? [record] : []) ?? [],
    ]);
    return [
      ...qb.map((record) => ({ downloaderInstanceId: record.downloaderInstanceId ?? 'qbittorrent', provider: 'qbittorrent' as const, name: record.name ?? 'qBittorrent' })),
      ...tr.map((record) => ({ downloaderInstanceId: record.downloaderInstanceId ?? 'transmission', provider: 'transmission' as const, name: record.name ?? 'Transmission' })),
    ];
  }

  async clientFor(ownerId: string, provider: DownloadProvider, downloaderInstanceId?: string, locale: Locale = 'en-US'): Promise<DownloadClient> {
    return aiStep('download.client.bind', async () => {
      const copy = downloadClientMessages[locale];
      if (!downloaderInstanceId && (await this.instancesFor(ownerId)).filter((choice) => choice.provider === provider).length > 1)
        throw new AppError(409, 'DOWNLOAD_PROVIDER_REQUIRED', copy.instanceRequired);
      if (provider === 'transmission') {
        const dependency = this.dependencies.transmission;
        const config = await dependency?.configs.find(ownerId, downloaderInstanceId);
        if (!dependency || !config) throw new AppError(409, 'TRANSMISSION_NOT_CONFIGURED', copy.notConfigured.transmission);
        normalizeTransmissionBaseUrl(config.baseUrl);
        return new TransmissionDownloadAdapter(dependency.client, config.baseUrl,
          decryptTransmissionCredential(config, this.dependencies.secrets), locale);
      }
      const dependency = this.dependencies.qbittorrent;
      const config = await dependency.configs.find(ownerId, downloaderInstanceId);
      if (!config) throw new AppError(409, 'QBITTORRENT_NOT_CONFIGURED', copy.notConfigured.qbittorrent);
      normalizeQBittorrentBaseUrl(config.baseUrl);
      return new QBittorrentDownloadAdapter(dependency.client, config.baseUrl,
        decryptCredential(config, this.dependencies.secrets), locale);
    }, { provider, downloaderInstanceId });
  }
}
