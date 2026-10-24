<script setup lang="ts">
import type { RemoteClientDevice, RemoteClientConfiguration, IntegrationPreferences, ApiError, DownloadProvider, DownloaderChoice, DownloadSource, DownloadProviderListResponse, MovieDetail, MovieDownload, MovieDownloadListResponse, MovieRelease, MovieResourceCheckResponse, MovieStatus, TrackedMovieStatus } from '@movie-hub/contract';
import { getIntegrationLogo } from '../settings/integration-logos';
import ResourceSiteSelector from './ResourceSiteSelector.vue';
import type { MovieSiteReleaseGroup } from './movie-site-releases.types';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const props = defineProps<{ tmdbId: number; authenticated: boolean }>();
const emit = defineEmits<{ back: []; requireLogin: [] }>();
const { apiBaseUrl } = loadWebConfig();
const { formatDate, formatDuration, formatNumber, locale, t } = useI18n();
const movie = ref<MovieDetail | null>(null);
const people = computed(() => {
  const combined = new Map((movie.value?.directors ?? []).map((person) => [person.tmdbId, {
    tmdbId: person.tmdbId, name: person.name, originalName: person.originalName, profileUrl: person.profileUrl,
    isDirector: true, characters: [] as string[],
  }]));
  for (const person of movie.value?.cast ?? []) {
    const existing = combined.get(person.tmdbId);
    if (existing) {
      if (!existing.originalName) existing.originalName = person.originalName;
      if (!existing.profileUrl) existing.profileUrl = person.profileUrl;
      if (person.character && !existing.characters.includes(person.character)) existing.characters.push(person.character);
    } else {
      combined.set(person.tmdbId, { tmdbId: person.tmdbId, name: person.name, originalName: person.originalName, profileUrl: person.profileUrl,
        isDirector: false, characters: person.character ? [person.character] : [] });
    }
  }
  return [...combined.values()];
});
const loading = ref(true);
const updating = ref(false);
const statusTooltipId = useId();
const errorMessage = ref('');
const resourceCheck = ref<MovieResourceCheckResponse | null>(null);
const resourceError = ref('');
const releases = ref<MovieRelease[]>([]);
const integrationPreferences = ref<IntegrationPreferences | null>(null);
const releaseGroups = ref<MovieSiteReleaseGroup[]>([]);
const expandedSites = ref<string[]>([]);
let releaseGeneration = 0;
let resourceGeneration = 0;
let releaseController: AbortController | undefined;
const releasesOpen = ref(false);
const releasesLoading = ref(false);
const releasesError = ref('');
const releaseDialog = ref<HTMLElement | null>(null);
const releasePanelContent = ref<HTMLElement | null>(null);
const activeDownloadReleaseId = ref('');
const releaseCloseButton = ref<HTMLButtonElement | null>(null);
const trailerOpen = ref(false);
const trailerDialog = ref<HTMLElement | null>(null);
const trailerCloseButton = ref<HTMLButtonElement | null>(null);
const downloads = ref<MovieDownload[]>([]);
const downloadProviders = ref<DownloaderChoice[]>([]);
const downloadProvidersError = ref('');
const selectedDownloaderId = ref('');
const remoteDevices = ref<RemoteClientDevice[]>([]);
let devicePoll: ReturnType<typeof setInterval> | undefined;
const downloadChoiceDialog = ref<HTMLElement | null>(null);
let downloadTrigger: HTMLElement | null = null;
const confirmingRelease = ref<MovieRelease | null>(null);
const confirmingSite = ref<DownloadSource>('mteam');
const submittingReleaseId = ref('');
const downloadErrors = ref<Record<string, string>>({});
let requestController: AbortController | undefined;
let resourcePoll: number | undefined;
let downloadPoll: number | undefined;
let releaseTrigger: HTMLElement | null = null;
let trailerTrigger: HTMLElement | null = null;
let previousBodyOverflow = '';
let pageScrollLocked = false;
const detailStyle = computed(() => {
  const hue = 14 + (props.tmdbId % 4) * 11;
  return { '--movie-accent': `hsl(${hue} 88% 58%)`, '--movie-accent-rgb': hue < 30 ? '242, 82, 45' : '242, 151, 45' };
});
function downloadKey(releaseId: string, site = 'mteam'): string {
  return `${site}:${releaseId}`;
}
function orderedGroupReleases(group: MovieSiteReleaseGroup): MovieRelease[] {
  const source = group.site === 'mteam' ? releases.value : group.result?.releases ?? [];
  const tracked = new Set(downloads.value.filter((item) => {
    return item.sourceProvider === group.site;
  }).map((item) => {
    return item.sourceReleaseId;
  }));
  const ordered = [...source.filter((item) => tracked.has(item.id)), ...source.filter((item) => !tracked.has(item.id))];
  const active = ordered.find((item) => downloadKey(item.id, group.site) === activeDownloadReleaseId.value);
  return active ? [active, ...ordered.filter((item) => item.id !== active.id)] : ordered;
}
const posterDownloadState = computed<'downloaded' | 'downloading' | null>(() => {
  if (downloads.value.some((download) => ['completed', 'seeding'].includes(download.status))) return 'downloaded';
  if (downloads.value.some((download) => ['submitting', 'downloading', 'paused'].includes(download.status)))
    return 'downloading';
  return null;
});

onMounted(() => {
  void load();
  if (props.authenticated) {
    void loadResourceCheck();
    void loadDownloadSnapshot();
  }
  devicePoll = setInterval(() => {
    if (releasesOpen.value && props.authenticated) void loadRemoteDevices();
  }, 60_000);
  document.addEventListener('visibilitychange', handleVisibilityChange);
});
onBeforeUnmount(() => {
  ++resourceGeneration;
  ++releaseGeneration;
  releaseController?.abort();
  requestController?.abort();
  stopResourcePolling();
  stopDownloadPolling();
  clearInterval(devicePoll);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  trailerOpen.value = false;
  releasesOpen.value = false;
  unlockPageScroll();
});
watch([() => props.tmdbId, locale], () => {
  releases.value = [];
  downloads.value = [];
  closeReleases(false);
  closeTrailer(false);
  releasesError.value = '';
  void load();
  if (props.authenticated) {
    void loadResourceCheck();
    void loadDownloadSnapshot();
  }
});
watch(
  () => props.authenticated,
  (authenticated) => {
    if (authenticated) {
      void loadResourceCheck();
      void loadDownloadSnapshot();
    } else {
      ++resourceGeneration;
      closeReleases(false);
      resourceCheck.value = null;
      downloads.value = [];
      stopResourcePolling();
      stopDownloadPolling();
    }
  });

async function load() {
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  loading.value = true;
  errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/movies/${props.tmdbId}?locale=${locale.value}`, {
      credentials: 'include',
      signal: controller.signal,
    });
    const body = (await response.json()) as MovieDetail | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.loadMovieDetails');
    movie.value = body as MovieDetail;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError'))
      errorMessage.value = localizedErrorMessage(error, 'errors.loadMovieDetails');
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

async function loadResourceCheck() {
  const generation = ++resourceGeneration;
  const requestedTmdbId = props.tmdbId;
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/resources`, { credentials: 'include' });
    const body = (await response.json()) as MovieResourceCheckResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.checkMovieResource');
    if (generation !== resourceGeneration || requestedTmdbId !== props.tmdbId || !props.authenticated) return;
    resourceCheck.value = body as MovieResourceCheckResponse;
    resourceError.value = '';
    if (resourceCheck.value.checking) scheduleResourcePoll();
    else stopResourcePolling();
  } catch (error) {
    if (generation !== resourceGeneration || requestedTmdbId !== props.tmdbId) return;
    resourceError.value = localizedErrorMessage(error, 'errors.checkMovieResource');
    stopResourcePolling();
  }
}

async function recheckResource() {
  if (!props.authenticated) {
    emit('requireLogin');
    return;
  }
  if (resourceCheck.value?.checking) return;
  const generation = ++resourceGeneration;
  const requestedTmdbId = props.tmdbId;
  const previous = resourceCheck.value;
  resourceCheck.value = { ...(previous ?? { provider: 'all', availability: 'unchecked' }), checking: true };
  stopResourcePolling();
  resourceError.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/resources/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    const body = (await response.json()) as MovieResourceCheckResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.checkMovieResource');
    if (generation !== resourceGeneration || requestedTmdbId !== props.tmdbId || !props.authenticated) return;
    resourceCheck.value = body as MovieResourceCheckResponse;
    scheduleResourcePoll();
  } catch (error) {
    if (generation !== resourceGeneration || requestedTmdbId !== props.tmdbId) return;
    resourceCheck.value = previous;
    resourceError.value = localizedErrorMessage(error, 'errors.checkMovieResource');
  }
}

function scheduleResourcePoll() {
  stopResourcePolling();
  resourcePoll = window.setTimeout(() => void loadResourceCheck(), 1_000);
}

function stopResourcePolling() {
  if (resourcePoll !== undefined) window.clearTimeout(resourcePoll);
  resourcePoll = undefined;
}

function resourceStatusLabel(): string {
  const check = resourceCheck.value;
  if (!check) return t('movie.resource.pending');
  if (check.incomplete && check.availability === 'available') return t('resourceSelection.availablePartial');
  if (check.checking) return t('movie.resource.checking');
  if (check.incomplete) return t('resourceSelection.incomplete');
  if (check.lastAttemptStatus === 'error') {
    if (!check.checkedAt) return t('movie.resource.checkFailed');
    if (check.availability === 'available') return t('movie.resource.availableRefreshFailed');
    if (check.availability === 'unavailable') return t('movie.resource.unavailableRefreshFailed');
    return t('movie.resource.checkFailed');
  }
  if (check.availability === 'available') return t('movie.resource.available');
  if (check.availability === 'unavailable') return t('movie.resource.unavailable');
  if (check.availability === 'unmatchable') return t('movie.resource.unmatchable');
  return t('movie.resource.pending');
}

function posterResourceState(): 'available' | 'checking' | 'error' | 'pending' | 'unavailable' | 'unmatchable' {
  const check = resourceCheck.value;
  if (!check) return 'pending';
  if (check.checking) return 'checking';
  if (check.availability === 'available') return 'available';
  if (check.availability === 'unavailable') return 'unavailable';
  if (check.availability === 'unmatchable') return 'unmatchable';
  if (check.lastAttemptStatus === 'error') return 'error';
  return 'pending';
}

function posterResourceLabel(): string {
  return t(`movie.resource.badge.${posterResourceState()}`);
}

function preferencesLoaded(preferences: IntegrationPreferences) {
  integrationPreferences.value = preferences;
}
function preferencesChanged(preferences: IntegrationPreferences) {
  integrationPreferences.value = preferences;
  closeReleases(false);
  void loadResourceCheck();
}
function groupToggled(site: string, event: Event) {
  const open = (event.target as HTMLDetailsElement).open;
  expandedSites.value = open
    ? [...new Set([...expandedSites.value, site])]
    : expandedSites.value.filter((id) => {
        return id !== site;
      });
}
async function loadReleaseGroup(group: MovieSiteReleaseGroup, more = false, refresh = false) {
  const generation = releaseGeneration;
  const requestedTmdbId = props.tmdbId;
  group.loading = true;
  group.error = '';
  try {
    const page = more ? group.result?.nextPage : undefined;
    const response = await fetch(`${apiBaseUrl}/me/movies/${requestedTmdbId}/resources/${group.site}/releases${refresh ? '/refresh' : page ? `?page=${page}` : ''}`, {
      method: refresh ? 'POST' : 'GET',
      credentials: 'include', signal: releaseController?.signal ?? null, headers: { 'accept-language': locale.value },
    });
    if (!response.ok) throw localizedApiError(await response.json(), 'errors.loadMovieReleases');
    const result = await response.json();
    if (generation !== releaseGeneration || requestedTmdbId !== props.tmdbId) return;
    if (more && group.result) {
      const known = new Set(group.result.releases.map((release) => release.id));
      result.releases = [...group.result.releases, ...result.releases.filter((release: MovieRelease) => {
        return !known.has(release.id);
      })];
    }
    group.result = result;
    group.supportsDownload = result.supportsDownload ?? group.supportsDownload;
    if (group.site === 'mteam') releases.value = result.releases;
  } catch (error) {
    if (generation === releaseGeneration && !(error instanceof DOMException && error.name === 'AbortError'))
      group.error = localizedErrorMessage(error, 'errors.loadMovieReleases');
  } finally { if (generation === releaseGeneration) group.loading = false; }
}
async function refreshReleaseGroup(group: MovieSiteReleaseGroup) {
  if (group.loading) return;
  const generation = releaseGeneration;
  await loadReleaseGroup(group, false, true);
  if (generation === releaseGeneration && releasesOpen.value) await loadResourceCheck();
}
function resourceAction() {
  if (resourceCheck.value?.availability === 'available') void showReleases();
  else void recheckResource();
}
async function showReleases() {
  if (!props.authenticated) {
    emit('requireLogin');
    return;
  }
  if (releasesLoading.value) return;
  releaseTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  releasesOpen.value = true;
  releasesLoading.value = true;
  releasesError.value = '';
  releaseGroups.value = [];
  releaseController?.abort();
  releaseController = new AbortController();
  const generation = ++releaseGeneration;
  lockPageScroll();
  await nextTick();
  releaseCloseButton.value?.focus();
  try {
    if (!integrationPreferences.value) {
      const response = await fetch(`${apiBaseUrl}/me/integration-preferences`, { credentials: 'include', signal: releaseController.signal });
      if (!response.ok) throw await localizedResponseError(response);
      integrationPreferences.value = await response.json();
    }
    if (generation !== releaseGeneration) return;
    const preferences = integrationPreferences.value!;
    const sites = [...preferences.effectiveSites].sort((a, b) => {
      return Number(b === preferences.defaults.resource) - Number(a === preferences.defaults.resource);
    });
    expandedSites.value = sites[0] ? [sites[0]] : [];
    releaseGroups.value = sites.map((site) => {
      return ({ site, name: preferences.choices.find(
        (choice) => choice.category === 'resource' && choice.id === site
      )?.name ?? site, supportsDownload: site === 'mteam', loading: true, error: '' });
    });
    await Promise.all([loadDownloadProviders(), loadRemoteDevices(), loadDownloads(), ...releaseGroups.value.map((group) => {
      return loadReleaseGroup(group);
    })]);
    if (generation === releaseGeneration) await loadResourceCheck();
  } catch (error) {
    if (generation === releaseGeneration) releasesError.value = localizedErrorMessage(error, 'errors.loadMovieReleases');
  } finally { if (generation === releaseGeneration) releasesLoading.value = false; }
}

function closeReleases(restoreFocus = true) {
  if (!releasesOpen.value) return;
  releasesOpen.value = false;
  releaseController?.abort();
  ++releaseGeneration;
  releasesLoading.value = false;
  activeDownloadReleaseId.value = '';
  confirmingRelease.value = null;
  stopDownloadPolling();
  unlockPageScroll();
  if (restoreFocus) {
    void nextTick(() => releaseTrigger?.focus());
  }
}

async function showTrailer() {
  if (!movie.value?.trailer) return;
  trailerTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  trailerOpen.value = true;
  lockPageScroll();
  await nextTick();
  trailerCloseButton.value?.focus();
}

function closeTrailer(restoreFocus = true) {
  if (!trailerOpen.value) return;
  trailerOpen.value = false;
  unlockPageScroll();
  if (restoreFocus) void nextTick(() => trailerTrigger?.focus());
}

function trailerEmbedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1`;
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
  const requestedTmdbId = props.tmdbId;
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${requestedTmdbId}/downloads`, { credentials: 'include' });
    const body = (await response.json()) as MovieDownloadListResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.movieDownloadFailed');
    if (requestedTmdbId !== props.tmdbId || !props.authenticated) return;
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

function requestDownload(release: MovieRelease, site = 'mteam') {
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

async function submitDownload(release: MovieRelease, choice: DownloaderChoice | undefined, site: DownloadSource = 'mteam', deviceId?: string) {
  if (submittingReleaseId.value) return;
  const requestedTmdbId = props.tmdbId;
  const key = downloadKey(release.id, site);
  submittingReleaseId.value = key;
  activeDownloadReleaseId.value = key;
  const generation = releaseGeneration;
  void nextTick(() => {
    const panel = releasePanelContent.value;
    if (!panel || !releasesOpen.value || generation !== releaseGeneration || requestedTmdbId !== props.tmdbId) return;
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
    const response = await fetch(`${apiBaseUrl}/me/movies/${requestedTmdbId}/downloads`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'accept-language': locale.value },
      body: JSON.stringify({ sourceReleaseId: release.id, ...(deviceId
        ? { remoteDeviceId: deviceId, sourceReleaseTitle: release.title.slice(0, 512) }
        : { provider: choice!.provider, downloaderInstanceId: choice!.downloaderInstanceId }), ...(site !== 'mteam' ? { sourceProvider: site } : {}) }),
    });
    const body = (await response.json()) as MovieDownload | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.movieDownloadFailed');
    if (requestedTmdbId !== props.tmdbId || !props.authenticated) return;
    const created = body as MovieDownload;
    downloads.value = [
      ...downloads.value.filter((item) => {
        return item.sourceReleaseId !== release.id || item.sourceProvider !== site;
      }),
      created,
    ];
    scheduleDownloadPoll();
  } catch (error) {
    if (requestedTmdbId === props.tmdbId && props.authenticated) {
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

function lockPageScroll() {
  if (pageScrollLocked) return;
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  pageScrollLocked = true;
}

function unlockPageScroll() {
  if (releasesOpen.value || trailerOpen.value || !pageScrollLocked) return;
  document.body.style.overflow = previousBodyOverflow;
  pageScrollLocked = false;
}

function handleReleaseDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (confirmingRelease.value) {
      cancelDownload();
      return;
    }
    closeReleases();
    return;
  }
  trapDialogFocus(event, confirmingRelease.value ? downloadChoiceDialog.value : releaseDialog.value);
}

function handleTrailerDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeTrailer();
    return;
  }
  trapDialogFocus(event, trailerDialog.value);
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement | null) {
  if (event.key !== 'Tab' || !dialog) return;
  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>(
      'summary, button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((element) => {
    const closed = element.closest('details:not([open])');
    return !closed || element === closed.querySelector('summary');
  });
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${formatNumber(amount, { maximumFractionDigits: amount >= 10 ? 1 : 2 })} ${units[unit]}`;
}

function discountLabel(value: string): string {
  const labels: Record<string, string> = {
    NORMAL: t('movie.releases.discount.normal'),
    PERCENT_70: '70%',
    PERCENT_50: '50%',
    FREE: t('movie.releases.discount.free'),
    _2X_FREE: `2× ${t('movie.releases.discount.free')}`,
    _2X: '2×',
    _2X_PERCENT_50: '2× / 50%',
  };
  return labels[value] ?? value;
}

async function setStatus(status: TrackedMovieStatus) {
  if (!props.authenticated) {
    emit('requireLogin');
    return;
  }
  if (!movie.value || updating.value) return;
  const previous = movie.value.userStatus;
  const next: MovieStatus = previous === status ? 'unwatched' : status;
  movie.value.userStatus = next;
  updating.value = true;
  errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/status`, {
      method: next === 'unwatched' ? 'DELETE' : 'PUT',
      credentials: 'include',
      ...(next === 'unwatched'
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: next }) }),
    });
    if (!response.ok) throw await localizedResponseError(response);
  } catch (error) {
    movie.value.userStatus = previous;
    errorMessage.value = localizedErrorMessage(error, 'errors.saveMovieStatus');
  } finally {
    updating.value = false;
  }
}

function releaseDateLabel(releaseDate?: string): string {
  return releaseDate ? formatDate(releaseDate, { dateStyle: 'long', timeZone: 'UTC' }) : t('movie.detail.missing');
}

function ratingLabel(rating?: number): string {
  return rating === undefined
    ? t('movie.detail.missing')
    : formatNumber(rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function syncedAtLabel(syncedAt: string): string {
  return formatDate(syncedAt, { dateStyle: 'medium', timeStyle: 'short' });
}
</script>

<template>
  <section class="detail-page">
    <button class="back-button detail-back" type="button" @click="emit('back')">{{ t('actions.back') }}</button>
    <div v-if="loading" class="movie-state" role="status">{{ t('status.loadingMovieDetails') }}</div>
    <div v-else-if="!movie" class="movie-state">
      <p>{{ errorMessage || t('errors.loadMovieDetails') }}</p>
      <button class="outline-button" type="button" @click="load">{{ t('actions.retry') }}</button>
    </div>
    <article v-else class="detail-content" :style="detailStyle">
      <div
        v-if="movie.backdropUrl"
        class="detail-backdrop"
        :style="{
          backgroundImage: `linear-gradient(90deg, #0b0c0d 0%, rgba(11,12,13,.45) 55%, #0b0c0d 100%), url(${movie.backdropUrl})`,
        }"
      ></div>
      <div class="detail-hero">
        <div class="detail-poster">
          <img v-if="movie.posterUrl" :src="movie.posterUrl" :alt="t('a11y.moviePoster', { title: movie.title })" />
          <div v-else class="poster-placeholder">
            <span>{{ t('movie.posterUnavailable') }}</span>
          </div>
          <span
            v-if="authenticated && posterDownloadState"
            class="poster-resource-badge"
            :class="`is-${posterDownloadState}`"
            :title="t(`movie.download.badge.${posterDownloadState}`)"
          >
            <span class="poster-resource-dot" aria-hidden="true"></span>
            <span>{{ t(`movie.download.badge.${posterDownloadState}`) }}</span>
          </span>
          <button
            v-else-if="authenticated && resourceCheck?.availability === 'available' && !resourceCheck.checking"
            class="poster-resource-badge"
            :class="`is-${posterResourceState()}`"
            type="button"
            :aria-label="resourceStatusLabel()"
            :title="resourceStatusLabel()"
            :disabled="releasesLoading"
            @click="showReleases"
          >
            <span class="poster-resource-dot" aria-hidden="true"></span>
            <span>{{ posterResourceLabel() }}</span>
          </button>
          <span
            v-else-if="authenticated"
            class="poster-resource-badge"
            :class="`is-${posterResourceState()}`"
            :title="resourceStatusLabel()"
          >
            <span class="poster-resource-dot" aria-hidden="true"></span>
            <span>{{ posterResourceLabel() }}</span>
          </span>
          <span class="poster-index">FILE {{ String(movie.tmdbId).padStart(6, '0') }}</span>
        </div>
        <div class="detail-copy">
          <p class="eyebrow">{{ t('movie.detail.eyebrow') }}</p>
          <h1>{{ movie.title }}</h1>
          <p v-if="movie.originalTitle && movie.originalTitle !== movie.title" class="detail-original">
            {{ movie.originalTitle }}
          </p>
          <p v-if="movie.tagline" class="tagline">“{{ movie.tagline }}”</p>
          <p class="overview detail-overview">{{ movie.overview || t('movie.detail.overviewMissing') }}</p>
          <dl class="dossier-data">
            <div>
              <dt>{{ t('movie.detail.release') }}</dt>
              <dd>{{ releaseDateLabel(movie.releaseDate) }}</dd>
            </div>
            <div>
              <dt>{{ t('movie.detail.runtime') }}</dt>
              <dd>
                {{
                  movie.runtimeMinutes === undefined ? t('movie.detail.missing') : formatDuration(movie.runtimeMinutes)
                }}
              </dd>
            </div>
            <div>
              <dt>{{ t('movie.detail.score') }}</dt>
              <dd class="rating">{{ ratingLabel(movie.voteAverage) }}</dd>
            </div>
            <div>
              <dt>{{ t('movie.detail.votes') }}</dt>
              <dd>{{ movie.voteCount === undefined ? t('movie.detail.missing') : formatNumber(movie.voteCount) }}</dd>
            </div>
          </dl>
          <div class="genre-list">
            <span v-for="genre in movie.genres" :key="genre.tmdbId">{{ genre.name }}</span>
            <span v-if="!movie.genres.length" class="genre-missing">{{ t('movie.detail.genresMissing') }}</span>
          </div>
          <div class="detail-action-toolbar">
          <div class="detail-media-actions" role="group" :aria-label="t('a11y.movieStatus', { title: movie.title })">
            <button v-if="movie.trailer" class="trailer-button" type="button" @click="showTrailer">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z" /></svg>
              {{ t('movie.trailer.play') }}
            </button>
            <button class="detail-state-icon watchlist-icon" type="button" :class="{ active: movie.userStatus === 'interested' }"
              :aria-pressed="movie.userStatus === 'interested'" :disabled="updating"
              :aria-label="t(movie.userStatus === 'interested' ? 'watchlist.remove' : 'watchlist.add')"
              :aria-describedby="`${statusTooltipId}-watchlist`" @click="setStatus('interested')">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4V3Z" /><path v-if="movie.userStatus === 'interested'" d="m9 9 2 2 4-4" /><path v-else d="M9 10h6m-3-3v6" /></svg>
              <span :id="`${statusTooltipId}-watchlist`" class="detail-state-tooltip" role="tooltip">{{ t(movie.userStatus === 'interested' ? 'watchlist.joined' : 'watchlist.notJoined') }}</span>
            </button>
            <button class="detail-state-icon watched-icon" type="button" :class="{ active: movie.userStatus === 'watched' }"
              :aria-pressed="movie.userStatus === 'watched'" :disabled="updating"
              :aria-label="t(movie.userStatus === 'watched' ? 'movie.status.markUnwatched' : 'movie.status.markWatched')"
              :aria-describedby="`${statusTooltipId}-watched`" @click="setStatus('watched')">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /><path v-if="movie.userStatus !== 'watched'" d="m3 3 18 18" /></svg>
              <span :id="`${statusTooltipId}-watched`" class="detail-state-tooltip" role="tooltip">{{ t(movie.userStatus === 'watched' ? 'movie.status.watched' : 'movie.status.unwatched') }}</span>
            </button>
          </div>
          <div v-if="authenticated" class="resource-check-panel">
            <span
              class="poster-resource-badge resource-toolbar-badge"
              :class="`is-${posterDownloadState ?? posterResourceState()}`"
              :title="posterDownloadState ? t(`movie.download.badge.${posterDownloadState}`) : resourceStatusLabel()"
              role="status"
            >
              <span class="poster-resource-dot" aria-hidden="true"></span>
              <span>{{ posterDownloadState ? t(`movie.download.badge.${posterDownloadState}`) : posterResourceLabel() }}</span>
            </span>
            <ResourceSiteSelector
              :disabled="Boolean(resourceCheck?.checking)" :check="resourceCheck"
              @loaded="preferencesLoaded" @changed="preferencesChanged"
            >
              <template #actions>
                <div class="resource-toolbar-actions">
                  <button
                    class="resource-status resource-status-button" type="button"
                    :disabled="releasesLoading || resourceCheck?.checking"
                    :title="resourceStatusLabel()" @click="resourceAction"
                  >
                    {{ t(resourceCheck?.checking ? 'movie.resource.checking' : resourceCheck?.availability === 'available' ? 'resourceSelection.viewResources' : 'resourceSelection.query') }}
                  </button>
                </div>
              </template>
            </ResourceSiteSelector>
          </div>
          </div>
          <p v-if="authenticated && resourceError" class="browse-error" role="alert">{{ resourceError }}</p>
          <p v-if="errorMessage" class="browse-error" role="alert">{{ errorMessage }}</p>
        </div>
      </div>
      <div class="detail-sections">
        <section :aria-label="t('movie.detail.people')">
          <p class="eyebrow">{{ t('movie.detail.people') }}</p>
          <div class="people-list">
            <div v-for="person in people" :key="person.tmdbId" class="person-card">
              <div class="person-photo">
                <img v-if="person.profileUrl" :src="person.profileUrl" :alt="person.name" />
                <div v-else class="person-placeholder">{{ person.name.slice(0, 1) }}</div>
                <span v-if="person.isDirector" class="person-role">{{ t('movie.detail.directorRole') }}</span>
              </div>
              <strong>{{ person.name }}</strong>
              <span v-if="person.isDirector && person.originalName && person.originalName !== person.name" class="person-original">{{ person.originalName }}</span>
              <span v-if="person.characters.length">{{ person.characters.join(' / ') }}</span>
              <span v-else-if="!person.isDirector">{{ t('movie.detail.characterMissing') }}</span>
            </div>
            <p v-if="!people.length" class="muted-copy">{{ t('movie.detail.peopleMissing') }}</p>
          </div>
        </section>
      </div>
      <p v-if="movie.stale" class="stale-note" role="status">
        {{ t('movie.detail.staleCache', { date: syncedAtLabel(movie.detailSyncedAt) }) }}
      </p>
    </article>
    <Teleport to="body">
      <div v-if="trailerOpen && movie?.trailer" class="trailer-dialog-backdrop" @click.self="closeTrailer()">
        <section
          ref="trailerDialog"
          class="trailer-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="trailer-dialog-title"
          tabindex="-1"
          @keydown="handleTrailerDialogKeydown"
        >
          <div class="trailer-panel-heading">
            <div>
              <p class="eyebrow">{{ t('movie.trailer.eyebrow') }}</p>
              <h2 id="trailer-dialog-title">{{ movie.trailer.name }}</h2>
            </div>
            <button ref="trailerCloseButton" class="text-button" type="button" @click="closeTrailer()">
              {{ t('movie.trailer.close') }}
            </button>
          </div>
          <div class="trailer-frame">
            <iframe
              :src="trailerEmbedUrl(movie.trailer.providerVideoId)"
              :title="t('movie.trailer.playerTitle', { title: movie.title })"
              allow="
                accelerometer;
                autoplay;
                clipboard-write;
                encrypted-media;
                gyroscope;
                picture-in-picture;
                web-share;
              "
              referrerpolicy="strict-origin-when-cross-origin"
              allowfullscreen
            ></iframe>
          </div>
        </section>
      </div>
      <div v-if="releasesOpen" class="release-dialog-backdrop" @click.self="closeReleases()">
        <section
          ref="releaseDialog"
          class="release-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="release-dialog-title"
          :aria-busy="releasesLoading && !releaseGroups.length"
          tabindex="-1"
          @keydown="handleReleaseDialogKeydown"
        >
          <div class="release-panel-heading">
            <div>
              <p class="eyebrow">{{ t('resourceSelection.sources') }}</p>
              <h2 id="release-dialog-title">{{ t('movie.releases.title') }}</h2>
            </div>
            <button ref="releaseCloseButton" class="text-button" type="button" @click="closeReleases()">
              {{ t('movie.releases.close') }}
            </button>
          </div>
          <div ref="releasePanelContent" class="release-panel-content">
            <p v-if="releasesError" class="browse-error" role="alert">{{ releasesError }}</p>
            <p v-if="releasesLoading && !releaseGroups.length" class="muted-copy" role="status">{{ t('movie.releases.loading') }}</p>
            <p v-if="!releasesLoading && !releaseGroups.length" class="muted-copy">{{ t('resourceSelection.none') }}</p>
            <details v-for="group in releaseGroups" :key="group.site" class="release-site-group" :open="expandedSites.includes(group.site)" @toggle="groupToggled(group.site, $event)">
              <summary>
                <strong>{{ group.name }}</strong>
                <span v-if="integrationPreferences?.defaults.resource === group.site" class="integration-default-badge">{{ t('integrationDefaults.default') }}</span>
                <span v-if="group.loading" class="release-site-status">{{ t('movie.releases.loading') }}</span>
                <span v-else-if="group.error" class="release-site-status">{{ t('movie.resource.checkFailed') }}</span>
                <span v-else class="release-site-status">{{ t('resourceSelection.releaseCount', { count: group.result?.releases.length ?? 0 }) }}</span>
                <button
                  type="button" class="release-site-refresh" :disabled="group.loading"
                  :aria-label="t('resourceSelection.refreshSite', { name: group.name })"
                  @click.stop.prevent="refreshReleaseGroup(group)"
                >{{ t(group.loading ? 'movie.releases.loading' : 'resourceSelection.refresh') }}</button>
              </summary>
              <div class="release-site-content" :aria-busy="group.loading">
                <p v-if="group.loading && !group.result" role="status">{{ t('movie.releases.loading') }}</p>
                <p v-if="group.error" class="browse-error" role="alert">{{ group.error }} <button type="button" class="text-button" :disabled="group.loading" @click="refreshReleaseGroup(group)">{{ t('actions.retry') }}</button></p>
                <p v-if="group.result" class="release-query-time">{{ t(group.error ? 'resourceSelection.staleResults' : group.result.cached ? 'resourceSelection.cachedAt' : 'resourceSelection.queriedAt', { date: formatDate(group.result.queriedAt, { dateStyle: 'short', timeStyle: 'short' }) }) }}</p>
                <p v-if="group.result && !group.result.releases.length && !group.loading" class="muted-copy">{{ t(group.result.availability === 'unmatchable' ? 'movie.resource.unmatchable' : 'movie.releases.empty') }}</p>
            <ol v-if="group.result?.releases.length" class="release-list">
              <li
                v-for="release in orderedGroupReleases(group)"
                :key="`${group.site}:${release.id}`"
                :data-release-key="downloadKey(release.id, group.site)"
                class="release-card"
                :class="downloadCardClass(release.id, group.site)"
              >
                <div class="release-title-row">
                  <h3>{{ release.title }}</h3>
                  <a
                    class="release-detail-link"
                    :href="release.detailsUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    :aria-label="t('movie.releases.openDetails')"
                    :title="t('movie.releases.openDetails')"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M14 5h5v5M19 5l-9 9M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                    </svg>
                  </a>
                </div>
                <dl class="release-facts">
                  <div v-if="release.sizeBytes !== undefined">
                    <dt>{{ t('movie.releases.size') }}</dt>
                    <dd>{{ formatBytes(release.sizeBytes) }}</dd>
                  </div>
                  <div
                    v-if="release.seedersKnown !== false"
                    class="release-fact-highlight"
                    :class="{ healthy: release.seeders > 50, 'low-seeders': release.seeders < 20 }"
                  >
                    <dt>{{ t('movie.releases.seeders') }}</dt>
                    <dd>{{ formatNumber(release.seeders) }}</dd>
                  </div>
                  <div v-if="release.leechers !== undefined" class="release-fact-highlight">
                    <dt>{{ t('movie.releases.leechers') }}</dt>
                    <dd>{{ formatNumber(release.leechers) }}</dd>
                  </div>
                  <div v-if="release.publishedAt">
                    <dt>{{ t('movie.releases.publishedAt') }}</dt>
                    <dd>{{ release.publishedAt }}</dd>
                  </div>
                  <div v-if="release.discount">
                    <dt>{{ t('movie.releases.discount') }}</dt>
                    <dd>{{ discountLabel(release.discount) }}</dd>
                  </div>
                  <div v-if="release.resolution">
                    <dt>{{ t('movie.releases.resolution') }}</dt>
                    <dd>{{ release.resolution }}</dd>
                  </div>
                  <div v-if="release.medium">
                    <dt>{{ t('movie.releases.medium') }}</dt>
                    <dd>{{ release.medium }}</dd>
                  </div>
                  <div v-if="release.videoCodec">
                    <dt>{{ t('movie.releases.videoCodec') }}</dt>
                    <dd>{{ release.videoCodec }}</dd>
                  </div>
                  <div v-if="release.releaseGroup">
                    <dt>{{ t('movie.releases.releaseGroup') }}</dt>
                    <dd>{{ release.releaseGroup }}</dd>
                  </div>
                  <div v-if="release.audioCodec">
                    <dt>{{ t('movie.releases.audioCodec') }}</dt>
                    <dd>{{ release.audioCodec }}</dd>
                  </div>
                </dl>
                <div v-if="release.tags.length" class="release-tags">
                  <span v-for="tag in release.tags" :key="tag">{{ tag === 'chinese-subtitles' ? t('movie.releases.tags.chineseSubtitles') : tag }}</span>
                </div>
                <div class="release-download-actions">
                  <span v-if="!canDownload(release.id, group.site)" class="muted-copy">{{ downloadUnavailable(release.id, group.site) }}</span>
                  <button
                    v-if="group.supportsDownload && (!downloadFor(release.id, group.site) || ['failed', 'missing'].includes(downloadFor(release.id, group.site)!.status))"
                    class="release-download-button"
                    type="button"
                    :disabled="!canDownload(release.id, group.site) || Boolean(submittingReleaseId)"
                    :aria-label="downloadActionLabel(release.id, group.site)"
                    :title="canDownload(release.id, group.site) ? downloadActionLabel(release.id, group.site) : downloadUnavailable(release.id, group.site)"
                    @click="requestDownload(release, group.site)"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" />
                    </svg>
                  </button>
                </div>
                <div
                  v-if="submittingReleaseId === downloadKey(release.id, group.site)"
                  class="release-download-progress downloading"
                  role="status"
                >
                  <div>
                    <span>{{ t('movie.download.submitting') }}</span>
                  </div>
                  <progress :aria-label="t('movie.download.submitting')"></progress>
                </div>
                <div
                  v-else-if="downloadFor(release.id, group.site)"
                  class="release-download-progress"
                  :class="{
                    missing: downloadFor(release.id, group.site)!.status === 'missing',
                    downloading: downloadFor(release.id, group.site)!.status === 'downloading',
                    seeding: ['completed', 'seeding'].includes(downloadFor(release.id, group.site)!.status),
                  }"
                  role="status"
                >
                  <div>
                    <span
                      >{{ downloadFor(release.id, group.site)!.downloaderName || providerName(downloadFor(release.id, group.site)!.provider) }} ·
                      {{ downloadStatus(downloadFor(release.id, group.site)!) }}</span
                    >
                    <strong v-if="downloadFor(release.id, group.site)!.status !== 'missing'">{{ Math.round(downloadFor(release.id, group.site)!.progress) }}%</strong>
                  </div>
                  <progress
                    v-if="downloadFor(release.id, group.site)!.status !== 'missing'"
                    :value="downloadFor(release.id, group.site)!.progress"
                    max="100"
                    :aria-label="
                      t('movie.download.progress', { progress: Math.round(downloadFor(release.id, group.site)!.progress) })
                    "
                  ></progress>
                </div>
                <p v-if="downloadFor(release.id, group.site)?.executionMode === 'remote' && downloadFor(release.id, group.site)?.queueExpiresAt && !['succeeded', 'duplicate'].includes(downloadFor(release.id, group.site)?.pushState ?? '')" class="download-retry-note" role="status">
                  {{ t('movie.download.agentExpires', { date: formatDate(downloadFor(release.id, group.site)!.queueExpiresAt!, { dateStyle: 'short', timeStyle: 'short' }) }) }}
                </p>
                <p v-if="downloadErrors[downloadKey(release.id, group.site)]" class="browse-error" role="alert">
                  {{ downloadErrors[downloadKey(release.id, group.site)] }}
                </p>
              </li>
            </ol>
                <button v-if="group.result?.nextPage" type="button" class="text-button" :disabled="group.loading" @click="loadReleaseGroup(group, true)">{{ t('resourceSelection.loadMore') }}</button>
              </div>
            </details>
          </div>
          <div
            v-if="confirmingRelease"
            ref="downloadChoiceDialog"
            class="download-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="download-confirm-title"
          >
            <div>
              <h3 id="download-confirm-title">{{ t('movie.download.confirmTitle') }}</h3>
              <fieldset class="download-provider-options" :aria-label="t('movie.download.provider')">
                <label v-for="choice in downloadProviders" :key="choice.downloaderInstanceId" class="download-provider-option">
                  <input
                    v-model="selectedDownloaderId"
                    type="radio"
                    name="download-provider"
                    :value="choice.downloaderInstanceId"
                    :disabled="
                      Boolean(
                        downloadFor(confirmingRelease.id, confirmingSite) && (downloadFor(confirmingRelease.id, confirmingSite)!.executionMode === 'remote' || choiceFor(downloadFor(confirmingRelease.id, confirmingSite)!)?.downloaderInstanceId !== choice.downloaderInstanceId),
                      )
                    "
                  />
                  <img :src="getIntegrationLogo(choice.provider)" alt="" class="download-provider-logo" aria-hidden="true" />
                  <span>{{ instanceLabel(choice) }}</span>
                </label>
                <hr v-if="downloadProviders.length && remoteDevices.length" class="download-provider-divider" />
                <label v-for="device in remoteDevices" :key="device.id" class="download-provider-option download-provider-option-agent" :title="t('movie.download.agentDeviceTooltip', { device: device.id })">
                  <input v-model="selectedDownloaderId" type="radio" name="download-provider" :value="`agent:${device.id}`" :disabled="!remoteAllowed(device.id)" />
                  <img src="/popular-link-agent-white-ui.png" alt="" class="download-provider-logo" aria-hidden="true" />
                  <span>
                    <b class="download-agent-name">
                      {{ t('movie.download.agentTarget') }}
                      <i
                        class="download-agent-status"
                        :class="{ 'is-online': device.isAgentOnline && device.isAgentDownloaderOnline }"
                        role="img"
                        :aria-label="t(device.isAgentOnline && device.isAgentDownloaderOnline ? 'remoteClient.online' : 'remoteClient.offline')"
                        :title="t(device.isAgentOnline && device.isAgentDownloaderOnline ? 'remoteClient.online' : 'remoteClient.offline')"
                      ></i>
                    </b>
                  </span>
                </label>
              </fieldset>
              <p v-if="selectedDownloaderId.startsWith('agent:')" class="download-retry-note" role="status">{{ t('movie.download.agentQueuePolicy') }}</p>
              <p v-if="downloadFor(confirmingRelease.id, confirmingSite)" class="download-retry-note">
                {{ t('movie.download.retryProvider') }}
              </p>
              <div class="download-confirm-actions">
                <button class="secondary" type="button" @click="cancelDownload">
                  {{ t('movie.download.cancel') }}
                </button>
                <button
                  class="primary"
                  type="button"
                  :disabled="!selectedDownloaderId || Boolean(submittingReleaseId)"
                  @click="confirmDownload"
                >
                  {{ t(selectedDownloaderId.startsWith('agent:') ? 'movie.download.pushAgent' : 'movie.download.confirm') }}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
@property --movie-download-border-angle {
  syntax: '<angle>';
  inherits: false;
  initial-value: 0deg;
}
.release-card.is-download-active,
.release-card.is-download-complete,
.release-card.is-download-paused,
.release-card.is-download-failed {
  position: relative;
  padding: 14px;
  border: 1px solid #70402d;
  border-radius: 6px;
  background: #181411;
}
.release-card.is-download-active::before {
  content: '';
  position: absolute;
  inset: -1px;
  padding: 2px;
  border-radius: inherit;
  background: conic-gradient(from var(--movie-download-border-angle), #73301e, #ff602f, #ffe0a0, #ff602f, #73301e);
  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask-composite: exclude;
  pointer-events: none;
  animation: movie-download-border-spin 3s linear infinite;
}
.release-card.is-download-complete {
  border-color: #4baf78;
  background: #101b15;
}
.release-card.is-download-failed {
  border-color: #9c4940;
  background: #1c1211;
}
@keyframes movie-download-border-spin {
  to {
    --movie-download-border-angle: 360deg;
  }
}
@media (prefers-reduced-motion: reduce) {
  .release-card.is-download-active::before {
    animation: none;
  }
}

.download-confirmation {
  position: fixed;
  padding: 16px;
}
.download-confirmation > div {
  width: min(380px, 100%);
  max-height: calc(100dvh - 32px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px;
  border-color: #303234;
  border-radius: 8px;
}
.download-confirmation h3 {
  margin: 0 0 16px;
  font-family: inherit;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.3;
}
.download-provider-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.download-provider-option {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid #303234;
  border-radius: 5px;
  color: #a5a6a2;
  background: #191b1c;
  font-size: 0.78rem;
  cursor: pointer;
}
.download-provider-option-agent { grid-column: 1 / -1; }
.download-agent-name { display: inline-flex; align-items: center; gap: 8px; font-weight: inherit; }
.download-agent-status { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; background: #e65b5b; }
.download-agent-status.is-online { background: #45c879; }
.download-provider-divider {
  grid-column: 1 / -1;
  width: 100%;
  margin: 4px 0;
  border: 0;
  border-top: 1px solid #303234;
}
.download-provider-option:has(input:checked) {
  border-color: #e84b2c;
  color: #f3f0e9;
  background: #2a1a16;
}
.download-provider-option:focus-within {
  outline: 2px solid #e84b2c;
  outline-offset: 2px;
}
.download-provider-option:has(input:disabled) {
  opacity: 0.5;
  cursor: default;
}
.download-provider-logo { flex-shrink: 0; margin-right: 8px; width: 20px; height: 20px; object-fit: contain; }
.download-provider-option input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  opacity: 0;
  cursor: inherit;
}
.download-provider-option span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
}
.download-provider-option span::after {
  content: '✓';
  color: #f25b3b;
  opacity: 0;
}
.download-provider-option:has(input:checked) span::after {
  opacity: 1;
}
.download-retry-note {
  margin: 10px 0 0;
  color: #858681;
  font-size: 0.72rem;
  line-height: 1.5;
}
.download-confirm-actions {
  gap: 8px;
  margin-top: 16px;
}
.download-confirm-actions button {
  padding: 9px 14px;
  border-radius: 5px;
  font-size: 0.78rem;
}
</style>
