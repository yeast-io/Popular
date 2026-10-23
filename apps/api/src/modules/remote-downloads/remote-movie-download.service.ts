import { randomUUID } from 'node:crypto';
import type { DownloadSource, Locale, MovieDownload } from '@movie-hub/contract';
import { AppError } from '../../infrastructure/http/app-error.js';
import { aiStep, currentAiTrace } from '../../infrastructure/logging/ai-trace.js';
import type { MovieDownloadStore } from '../downloads/movie-download.types.js';
import { toResponse } from '../downloads/movie-download.presentation.js';
import type { RemoteClientService } from '../remote-clients/remote-client.service.js';
import type { RemoteDownloadCoordinator } from './remote-download-coordinator.service.js';
import { remoteDownloadMessages } from './remote-download.messages.js';

export class RemoteMovieDownloadService {
  constructor(
    readonly downloads: MovieDownloadStore,
    readonly clients: RemoteClientService,
    readonly coordinator: RemoteDownloadCoordinator
  ) {}

  async create(ownerId: string, tmdbId: number, releaseId: string, source: DownloadSource,
    deviceId: string, locale: Locale, displayTitle?: string): Promise<MovieDownload> {
    const correlationId = currentAiTrace()?.correlationId ?? randomUUID();
    const configuration = await this.clients.get(ownerId);
    const device = configuration.devices.find((item) => item.id === deviceId);
    if (!configuration.hasKey || !device)
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', remoteDownloadMessages[locale].invalidDevice);
    const existing = await this.downloads.findByRelease(ownerId, tmdbId, releaseId, source);
    if (existing && existing.status !== 'missing' && (existing.executionMode !== 'remote' || existing.remoteDeviceId !== deviceId))
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', remoteDownloadMessages[locale].targetConflict);
    const remote = { ...(displayTitle ? { displayTitle } : {}), deviceId, authVersion: device.authVersion,
      deviceVersion: device.deviceVersion, correlationId,
      ...(device.downloaderType && device.downloaderInstanceId
        ? { targetDownloader: {
            downloaderType: device.downloaderType, instanceId: device.downloaderInstanceId } }
        : {}) };
    const { record } = existing
      ? existing.status === 'missing'
        ? await aiStep('remote-queue.download.requeue-missing', () => this.downloads.claimMissing(existing, device.downloaderType, undefined, remoteDownloadMessages[locale].agent, remote),
            { downloadId: existing.id, previousCommandId: existing.remoteCommandId })
        : { record: existing }
      : await aiStep('remote-queue.download.claim', () => this.downloads.createSubmitting(
          ownerId, tmdbId, releaseId, device.downloaderType, source, undefined,
          remoteDownloadMessages[locale].agent, remote));
    if (record.executionMode !== 'remote' || record.remoteDeviceId !== deviceId || !record.remoteCommandId)
      throw new AppError(409, 'DOWNLOAD_PROVIDER_CONFLICT', remoteDownloadMessages[locale].targetConflict);
    await this.coordinator.enqueue({ commandId: record.remoteCommandId, downloadId: record.id, ownerId,
      deviceId, authVersion: device.authVersion, deviceVersion: device.deviceVersion, source, resourceId: releaseId,
      correlationId: record.remoteCorrelationId ?? correlationId });
    return toResponse((await this.downloads.findByRelease(ownerId, tmdbId, releaseId, source))!);
  }
}
