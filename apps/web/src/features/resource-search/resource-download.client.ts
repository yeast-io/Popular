import type { ApiError, DownloadProvider, DownloaderChoice, DownloadSource, DownloadProviderListResponse, MovieDownload, MovieDownloadListResponse, RemoteClientConfiguration, RemoteClientDevice, ResourceSiteRelease } from '@movie-hub/contract';
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage } from '../../i18n/api-error';
import type { ResourceDownloadContext } from './resource-download.types';

export function useResourceDownloads(context: ResourceDownloadContext) {
  const { apiBaseUrl } = loadWebConfig();
  const { t, locale } = useI18n();
  const integrationPreferences = context.preferences;
  const releasesOpen = context.open;
  const releasePanelContent = context.panel;
  const activeDownloadReleaseId = context.activeRelease;
  let disposed = false;
  const downloads = ref<MovieDownload[]>([]);
  const downloadProviders = ref<DownloaderChoice[]>([]);
  const downloadProvidersError = ref('');
  const selectedDownloaderId = ref('');
  const remoteDevices = ref<RemoteClientDevice[]>([]);
  const downloadChoiceDialog = ref<HTMLElement | null>(null);
  const confirmingRelease = ref<ResourceSiteRelease | null>(null);
  const confirmingSite = ref<DownloadSource>('mteam');
  const submittingReleaseId = ref('');
  const downloadErrors = ref<Record<string, string>>({});
  let downloadTrigger: HTMLElement | null = null;
  let downloadPoll: number | undefined;
  function downloadKey(releaseId: string, site = 'mteam'): string {
    return `${site}:${releaseId}`;
  }
  function downloadsPath(tmdbId: number | undefined) {
    return tmdbId === undefined ? '/me/resource-downloads' : `/me/movies/${tmdbId}/downloads`;
  }
  async function loadRemoteDevices() {
    try {
      const response = await fetch(`${apiBaseUrl}/me/remote-client`, { credentials: 'include', cache: 'no-store',
        headers: { 'accept-language': locale.value } });
      if (!response.ok) throw new Error('Device status unavailable');
      const result = await response.json() as RemoteClientConfiguration;
      remoteDevices.value = result.hasKey && Array.isArray(result.devices) ? result.devices : [];
    } catch { remoteDevices.value = []; }
  }

  function remoteAllowed(deviceId: string): boolean {
    const prior = confirmingRelease.value ? downloadFor(confirmingRelease.value.id, confirmingSite.value) : undefined;
    return !prior || (prior.executionMode === 'remote' && prior.remoteDeviceId === deviceId);
  }

  async function loadDownloadProviders() {
    downloadProviders.value = [];
    downloadProvidersError.value = '';
    try {
      const response = await fetch(`${apiBaseUrl}/me/download-providers`, { credentials: 'include' });
      if (!response.ok) throw localizedApiError(await response.json(), 'movie.download.providersFailed');
      const result = (await response.json()) as DownloadProviderListResponse;
      if (!Array.isArray(result.providers)) throw new Error('Invalid downloader list');
      downloadProviders.value = result.providers.map((provider) => typeof provider === 'string'
        ? { downloaderInstanceId: provider, provider: provider as DownloadProvider, name: providerName(provider as DownloadProvider) }
        : provider);
      const preferred = integrationPreferences.value?.defaults.downloader;
      selectedDownloaderId.value = downloadProviders.value.find((choice) => choice.downloaderInstanceId === preferred)?.downloaderInstanceId
        ?? (downloadProviders.value.length === 1 ? downloadProviders.value[0]!.downloaderInstanceId : '');
    } catch (error) {
      downloadProvidersError.value = localizedErrorMessage(error, 'movie.download.providersFailed');
    }
  }

  async function loadDownloads() {
    if (!releasesOpen.value || document.visibilityState === 'hidden') return;
    await fetchDownloads();
  }

  async function loadDownloadSnapshot() {
    await fetchDownloads();
  }

  async function fetchDownloads() {
    const requestedTmdbId = context.tmdbId();
    try {
      const response = await fetch(`${apiBaseUrl}${downloadsPath(requestedTmdbId)}`, { credentials: 'include' });
      const body = (await response.json()) as MovieDownloadListResponse | ApiError;
      if (!response.ok) throw localizedApiError(body, 'errors.movieDownloadFailed');
      if (requestedTmdbId !== context.tmdbId() || (!context.authenticated() || disposed)) return;
      const items = (body as MovieDownloadListResponse).items;
      downloads.value = Array.isArray(items) ? items : [];
      if (releasesOpen.value) scheduleDownloadPoll();
    } catch {
      stopDownloadPolling();
    }
  }

  function downloadFor(releaseId: string, site = 'mteam'): MovieDownload | undefined {
    return downloads.value.find((download) => download.sourceProvider === site && download.sourceReleaseId === releaseId);
  }

  function downloadCardClass(releaseId: string, site = 'mteam'): string | undefined {
    if (submittingReleaseId.value === downloadKey(releaseId, site)) return 'is-download-active';
    if (downloadErrors.value[downloadKey(releaseId, site)]) return 'is-download-failed';
    const status = downloadFor(releaseId, site)?.status;
    if (status === 'submitting' || status === 'downloading') return 'is-download-active';
    if (status === 'completed' || status === 'seeding') return 'is-download-complete';
    if (status === 'paused') return 'is-download-paused';
    if (status === 'failed') return 'is-download-failed';
    return undefined;
  }

  function providerName(provider: DownloadProvider | undefined): string {
    if (!provider) return t('movie.download.agentName');
    return provider === 'transmission' ? 'Transmission' : 'qBittorrent';
  }

  function instanceLabel(choice: DownloaderChoice): string {
    return choice.name?.trim() || providerName(choice.provider);
  }

  function downloadActionLabel(releaseId: string, site: string): string {
    if (submittingReleaseId.value === downloadKey(releaseId, site)) return t('movie.download.submitting');
    const download = downloadFor(releaseId, site);
    return download
      ? t(download.status === 'missing' ? 'movie.download.redownload' : 'movie.download.retry')
      : t('movie.download.action');
  }

  function choiceFor(download: MovieDownload): DownloaderChoice | undefined {
    if (download.downloaderInstanceId)
      return downloadProviders.value.find((choice) => choice.downloaderInstanceId === download.downloaderInstanceId);
    const sameType = downloadProviders.value.filter((choice) => choice.provider === download.provider);
    return sameType.length === 1 ? sameType[0] : undefined;
  }

  function canDownload(releaseId: string, site = 'mteam'): boolean {
    if (site !== 'mteam' && site !== 'hdarea') return false;
    const existing = downloadFor(releaseId, site);
    return existing
      ? existing.status === 'missing'
        ? downloadProviders.value.length > 0 || remoteDevices.value.length > 0
        : (existing.executionMode === 'remote'
            ? remoteDevices.value.some((device) => device.id === existing.remoteDeviceId)
            : Boolean(choiceFor(existing)))
      : downloadProviders.value.length > 0 || remoteDevices.value.length > 0;
  }

  function downloadUnavailable(releaseId: string, site = 'mteam'): string {
    if (site !== 'mteam' && site !== 'hdarea') return t('resourceSelection.downloadUnsupported');
    return (
      downloadProvidersError.value
      || (downloadFor(releaseId, site) ? t('movie.download.originalUnconfigured') : t('movie.download.unconfigured'))
    );
  }

  function requestDownload(release: ResourceSiteRelease, site = 'mteam') {
    if (site !== 'mteam' && site !== 'hdarea') return;
    if (!canDownload(release.id, site) || submittingReleaseId.value) return;
    downloadTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = downloadFor(release.id, site);
    const prior = previous?.status === 'missing' ? undefined : previous;
    const original = prior ? choiceFor(prior) : undefined;
    const selected = original ?? downloadProviders.value.find((choice) => choice.downloaderInstanceId === (selectedDownloaderId.value || integrationPreferences.value?.defaults.downloader))
      ?? (downloadProviders.value.length === 1 ? downloadProviders.value[0] : undefined);
    selectedDownloaderId.value = prior?.executionMode === 'remote'
      ? `agent:${prior.remoteDeviceId}`
      : selected?.downloaderInstanceId ?? '';
    if (!selectedDownloaderId.value && !downloadProviders.value.length && remoteDevices.value.length === 1)
      selectedDownloaderId.value = `agent:${remoteDevices.value[0]!.id}`;
    confirmingRelease.value = release;
    confirmingSite.value = site;
    void nextTick(() => {
      return downloadChoiceDialog.value?.querySelector<HTMLElement>('input:checked, input:not([disabled])')?.focus();
    });
  }

  function cancelDownload() {
    confirmingRelease.value = null;
    selectedDownloaderId.value = '';
    void nextTick(() => downloadTrigger?.focus({ preventScroll: true }));
  }

  async function confirmDownload() {
    const release = confirmingRelease.value;
    const choice = downloadProviders.value.find((item) => item.downloaderInstanceId === selectedDownloaderId.value);
    const site = confirmingSite.value;
    const deviceId = selectedDownloaderId.value.startsWith('agent:') ? selectedDownloaderId.value.slice(6) : undefined;
    if (!release || (!choice && !deviceId) || submittingReleaseId.value) return;
    if (deviceId && !remoteAllowed(deviceId)) return;
    cancelDownload();
    await submitDownload(release, choice, site, deviceId);
  }

  async function submitDownload(release: ResourceSiteRelease, choice: DownloaderChoice | undefined, site: DownloadSource = 'mteam', deviceId?: string) {
    if (submittingReleaseId.value) return;
    const requestedTmdbId = context.tmdbId();
    const key = downloadKey(release.id, site);
    submittingReleaseId.value = key;
    activeDownloadReleaseId.value = key;
    const generation = context.generation();
    void nextTick(() => {
      const panel = releasePanelContent.value;
      if (!panel || !releasesOpen.value || generation !== context.generation() || requestedTmdbId !== context.tmdbId()) return;
      const card = Array.from(panel.querySelectorAll<HTMLElement>('[data-release-key]')).find((element) => {
        return element.dataset.releaseKey === key;
      });
      if (!card) return;
      const top = panel.scrollTop + card.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientTop;
      panel.scrollTo({
        top: Math.max(0, top),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      }
      );
    });
    downloadErrors.value = { ...downloadErrors.value, [key]: '' };
    try {
      const response = await fetch(`${apiBaseUrl}${downloadsPath(requestedTmdbId)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'accept-language': locale.value },
        body: JSON.stringify({ ...(context.query ? { query: context.query(), page: context.page?.(site, release.id) ?? 1 } : {}), sourceReleaseId: release.id, ...(deviceId
          ? { remoteDeviceId: deviceId, sourceReleaseTitle: release.title.slice(0, 512) }
          : { provider: choice!.provider, downloaderInstanceId: choice!.downloaderInstanceId }), ...(site !== 'mteam' ? { sourceProvider: site } : {}) }),
      });
      const body = (await response.json()) as MovieDownload | ApiError;
      if (!response.ok) throw localizedApiError(body, 'errors.movieDownloadFailed');
      if (requestedTmdbId !== context.tmdbId() || (!context.authenticated() || disposed)) return;
      const created = body as MovieDownload;
      downloads.value = [
        ...downloads.value.filter((item) => {
          return item.sourceReleaseId !== release.id || item.sourceProvider !== site;
        }),
        created,
      ];
      scheduleDownloadPoll();
    } catch (error) {
      if (requestedTmdbId === context.tmdbId() && context.authenticated() && !disposed) {
        downloadErrors.value = {
          ...downloadErrors.value,
          [key]: localizedErrorMessage(error, 'errors.movieDownloadFailed'),
        };
      }
    } finally {
      submittingReleaseId.value = '';
    }
  }

  function scheduleDownloadPoll() {
    stopDownloadPolling();
    if (!releasesOpen.value || document.visibilityState === 'hidden') return;
    if (
      !downloads.value.some((download) => {
        return ['submitting', 'downloading', 'paused', 'seeding'].includes(download.status)
          // A successfully added remote task can recover from downloader errors or reappear later.
          || (download.executionMode === 'remote' && download.pushState === 'succeeded' && download.status !== 'missing')
          || Boolean(download.queueExpiresAt && !['succeeded', 'duplicate', 'cancelled', 'closed'].includes(download.pushState ?? ''));
      })
    )
      return;
    downloadPoll = window.setTimeout(() => void loadDownloads(), 2_000);
  }

  function stopDownloadPolling() {
    if (downloadPoll !== undefined) window.clearTimeout(downloadPoll);
    downloadPoll = undefined;
  }

  function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') stopDownloadPolling();
    else if (releasesOpen.value) void loadDownloads();
  }

  function downloadStatus(download: MovieDownload): string {
    if (download.executionMode === 'remote' && !['succeeded', 'duplicate'].includes(download.pushState ?? '')) {
      if (download.pushState === 'unknown') return t('movie.download.agentUnknown');
      if (download.pushState === 'failed' || download.lastErrorCode) return t('movie.download.agentRetry');
      if (['cancelled', 'closed', 'expired'].includes(download.pushState ?? '')) return t('movie.download.agentClosed');
      return t('movie.download.agentQueued');
    }
    return t(`movie.download.status.${download.status}` as `movie.download.status.${MovieDownload['status']}`);
  }

  onBeforeUnmount(() => {
    disposed = true;
    stopDownloadPolling();
  });
  return {
    downloads, downloadProviders, downloadProvidersError, selectedDownloaderId, remoteDevices, downloadChoiceDialog,
    confirmingRelease, confirmingSite, submittingReleaseId, downloadErrors,
    downloadKey, loadRemoteDevices, remoteAllowed, loadDownloadProviders, loadDownloads, loadDownloadSnapshot,
    downloadFor, downloadCardClass, providerName, instanceLabel, downloadActionLabel, choiceFor, canDownload,
    downloadUnavailable, requestDownload, cancelDownload, confirmDownload, stopDownloadPolling, handleVisibilityChange, downloadStatus,
  };
}
