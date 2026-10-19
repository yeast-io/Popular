<script setup lang="ts">
import type {
  ApiError,
  DownloadProvider,
  DownloadProviderListResponse,
  MovieDetail,
  MovieDownload,
  MovieDownloadListResponse,
  MovieRelease,
  MovieReleaseListResponse,
  MoviePreference,
  MovieResourceCheckResponse,
  MovieStatus,
  TrackedMoviePreference,
  TrackedMovieStatus,
} from '@movie-hub/contract';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const props = defineProps<{ tmdbId: number; authenticated: boolean }>();
const emit = defineEmits<{ back: []; requireLogin: [] }>();
const { apiBaseUrl } = loadWebConfig();
const { formatDate, formatDuration, formatNumber, locale, t } = useI18n();
const movie = ref<MovieDetail | null>(null);
const loading = ref(true);
const updating = ref(false);
const errorMessage = ref('');
const resourceCheck = ref<MovieResourceCheckResponse | null>(null);
const resourceError = ref('');
const releases = ref<MovieRelease[]>([]);
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
const downloadProviders = ref<DownloadProvider[]>([]);
const downloadProvidersError = ref('');
const selectedProvider = ref<DownloadProvider | ''>('');
const downloadChoiceDialog = ref<HTMLElement | null>(null);
let downloadTrigger: HTMLElement | null = null;
const confirmingRelease = ref<MovieRelease | null>(null);
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
const statusOptions = computed(() => {
  return [
    ['watched', t('movie.status.watched')],
    ['interested', t('movie.status.interested')],
  ] as const;
});
const orderedReleases = computed(() => {
  const downloadedReleaseIds = new Set(downloads.value.map((download) => download.sourceReleaseId));
  const downloaded: MovieRelease[] = [];
  const notDownloaded: MovieRelease[] = [];
  for (const release of releases.value) {
    (downloadedReleaseIds.has(release.id) ? downloaded : notDownloaded).push(release);
  }
  const ordered = [...downloaded, ...notDownloaded];
  const active = ordered.find((release) => release.id === activeDownloadReleaseId.value);
  return active ? [active, ...ordered.filter((release) => release.id !== active.id)] : ordered;
});
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
  document.addEventListener('visibilitychange', handleVisibilityChange);
});
onBeforeUnmount(() => {
  requestController?.abort();
  stopResourcePolling();
  stopDownloadPolling();
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
      resourceCheck.value = null;
      downloads.value = [];
      stopResourcePolling();
      stopDownloadPolling();
    }
  },
);

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
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/resources/mteam`, { credentials: 'include' });
    const body = (await response.json()) as MovieResourceCheckResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.checkMovieResource');
    resourceCheck.value = body as MovieResourceCheckResponse;
    resourceError.value = '';
    if (resourceCheck.value.checking) scheduleResourcePoll();
    else stopResourcePolling();
  } catch (error) {
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
  resourceError.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/resources/mteam/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    const body = (await response.json()) as MovieResourceCheckResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.checkMovieResource');
    resourceCheck.value = body as MovieResourceCheckResponse;
    scheduleResourcePoll();
  } catch (error) {
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
  if (check.checking) return t('movie.resource.checking');
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

async function showReleases() {
  if (!props.authenticated) {
    emit('requireLogin');
    return;
  }
  if (releasesLoading.value) return;
  releaseTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  releasesOpen.value = true;
  lockPageScroll();
  await nextTick();
  releaseCloseButton.value?.focus();
  releasesLoading.value = true;
  releasesError.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/resources/mteam/releases`, {
      credentials: 'include',
    });
    const body = (await response.json()) as MovieReleaseListResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.loadMovieReleases');
    const result = body as MovieReleaseListResponse;
    releases.value = result.releases;
    resourceCheck.value = {
      provider: 'mteam',
      checking: false,
      availability: result.availability,
      lastAttemptStatus: 'success',
      checkedAt: result.queriedAt,
    };
    await Promise.all([loadDownloadProviders(), loadDownloads()]);
  } catch (error) {
    releases.value = [];
    releasesError.value = localizedErrorMessage(error, 'errors.loadMovieReleases');
  } finally {
    releasesLoading.value = false;
  }
}

function closeReleases(restoreFocus = true) {
  if (!releasesOpen.value) return;
  releasesOpen.value = false;
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

async function loadDownloadProviders() {
  downloadProviders.value = [];
  downloadProvidersError.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/download-providers`, { credentials: 'include' });
    if (!response.ok) throw localizedApiError(await response.json(), 'movie.download.providersFailed');
    const result = (await response.json()) as DownloadProviderListResponse;
    if (!Array.isArray(result.providers)) throw new Error('Invalid downloader list');
    downloadProviders.value = result.providers;
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

function downloadFor(releaseId: string): MovieDownload | undefined {
  return downloads.value.find((download) => download.sourceReleaseId === releaseId);
}

function downloadCardClass(releaseId: string): string | undefined {
  if (submittingReleaseId.value === releaseId) return 'is-download-active';
  if (downloadErrors.value[releaseId]) return 'is-download-failed';
  const status = downloadFor(releaseId)?.status;
  if (status === 'submitting' || status === 'downloading') return 'is-download-active';
  if (status === 'completed' || status === 'seeding') return 'is-download-complete';
  if (status === 'paused') return 'is-download-paused';
  if (status === 'failed' || status === 'missing') return 'is-download-failed';
  return undefined;
}

function providerName(provider: DownloadProvider): string {
  return provider === 'transmission' ? 'Transmission' : 'qBittorrent';
}

function canDownload(releaseId: string): boolean {
  const existing = downloadFor(releaseId);
  return existing ? downloadProviders.value.includes(existing.provider) : downloadProviders.value.length > 0;
}

function downloadUnavailable(releaseId: string): string {
  return (
    downloadProvidersError.value ||
    (downloadFor(releaseId) ? t('movie.download.originalUnconfigured') : t('movie.download.unconfigured'))
  );
}

function requestDownload(release: MovieRelease) {
  if (!canDownload(release.id) || submittingReleaseId.value) return;
  downloadTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const original = downloadFor(release.id)?.provider;
  if (downloadProviders.value.length === 1) {
    void submitDownload(release, original ?? downloadProviders.value[0]!);
    return;
  }
  selectedProvider.value = original ?? '';
  confirmingRelease.value = release;
  void nextTick(() => {
    return downloadChoiceDialog.value?.querySelector<HTMLElement>('input:checked, input:not([disabled])')?.focus();
  });
}

function cancelDownload() {
  confirmingRelease.value = null;
  selectedProvider.value = '';
  void nextTick(() => downloadTrigger?.focus({ preventScroll: true }));
}

async function confirmDownload() {
  const release = confirmingRelease.value;
  const provider = selectedProvider.value;
  if (!release || !provider || submittingReleaseId.value) return;
  cancelDownload();
  await submitDownload(release, provider);
}

async function submitDownload(release: MovieRelease, provider: DownloadProvider) {
  if (submittingReleaseId.value) return;
  const requestedTmdbId = props.tmdbId;
  submittingReleaseId.value = release.id;
  activeDownloadReleaseId.value = release.id;
  void nextTick(() => {
    if (requestedTmdbId === props.tmdbId && releasePanelContent.value) releasePanelContent.value.scrollTop = 0;
  });
  downloadErrors.value = { ...downloadErrors.value, [release.id]: '' };
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${requestedTmdbId}/downloads`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceReleaseId: release.id, provider }),
    });
    const body = (await response.json()) as MovieDownload | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.movieDownloadFailed');
    if (requestedTmdbId !== props.tmdbId || !props.authenticated) return;
    const created = body as MovieDownload;
    downloads.value = [
      ...downloads.value.filter((item) => {
        return item.sourceReleaseId !== release.id;
      }),
      created,
    ];
    scheduleDownloadPoll();
  } catch (error) {
    if (requestedTmdbId === props.tmdbId && props.authenticated) {
      downloadErrors.value = {
        ...downloadErrors.value,
        [release.id]: localizedErrorMessage(error, 'errors.movieDownloadFailed'),
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
      return ['submitting', 'downloading', 'paused', 'seeding'].includes(download.status);
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
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
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

async function setPreference(preference: TrackedMoviePreference) {
  if (!props.authenticated) {
    emit('requireLogin');
    return;
  }
  if (!movie.value || updating.value) return;
  const previous = movie.value.userPreference;
  const next: MoviePreference = previous === preference ? 'neutral' : preference;
  movie.value.userPreference = next;
  updating.value = true;
  errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/preference`, {
      method: next === 'neutral' ? 'DELETE' : 'PUT',
      credentials: 'include',
      ...(next === 'neutral'
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preference: next }) }),
    });
    if (!response.ok) throw await localizedResponseError(response);
  } catch (error) {
    movie.value.userPreference = previous;
    errorMessage.value = localizedErrorMessage(error, 'errors.saveMoviePreference');
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
            v-if="posterDownloadState"
            class="poster-resource-badge"
            :class="`is-${posterDownloadState}`"
            :title="t(`movie.download.badge.${posterDownloadState}`)"
          >
            <span class="poster-resource-dot" aria-hidden="true"></span>
            <span>{{ t(`movie.download.badge.${posterDownloadState}`) }}</span>
          </span>
          <button
            v-else-if="resourceCheck?.availability === 'available' && !resourceCheck.checking"
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
            v-else
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
          <button v-if="movie.trailer" class="trailer-button" type="button" @click="showTrailer">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z" /></svg>
            {{ t('movie.trailer.play') }}
          </button>
          <div
            class="status-control detail-status"
            role="group"
            :aria-label="t('a11y.movieStatus', { title: movie.title })"
          >
            <button
              v-for="option in statusOptions"
              :key="option[0]"
              type="button"
              :class="{ active: movie.userStatus === option[0] }"
              :aria-pressed="movie.userStatus === option[0]"
              :disabled="updating"
              @click="setStatus(option[0])"
            >
              {{ option[1] }}
            </button>
          </div>
          <div class="detail-preference" role="group" :aria-label="t('a11y.moviePreference', { title: movie.title })">
            <button
              type="button"
              class="liked"
              :class="{ active: movie.userPreference === 'liked' }"
              :aria-pressed="movie.userPreference === 'liked'"
              :disabled="updating"
              @click="setPreference('liked')"
            >
              <span aria-hidden="true">♥</span>{{ t('movie.preference.liked') }}
            </button>
            <button
              type="button"
              class="disliked"
              :class="{ active: movie.userPreference === 'disliked' }"
              :aria-pressed="movie.userPreference === 'disliked'"
              :disabled="updating"
              @click="setPreference('disliked')"
            >
              <span aria-hidden="true">👎</span>{{ t('movie.preference.disliked') }}
            </button>
          </div>
          <div class="resource-check-panel">
            <strong>{{ t('movie.resource.sectionTitle') }}</strong>
            <div class="resource-check-row">
              <button
                v-if="resourceCheck?.availability === 'available' && !resourceCheck.checking"
                class="resource-status resource-status-button"
                :class="{ error: resourceCheck.lastAttemptStatus === 'error' }"
                type="button"
                :disabled="releasesLoading"
                @click="showReleases"
              >
                {{ resourceStatusLabel() }}
              </button>
              <p
                v-else
                class="resource-status"
                :class="{ error: resourceCheck?.lastAttemptStatus === 'error' }"
                role="status"
              >
                {{ resourceStatusLabel() }}
              </p>
              <button
                class="resource-check-button"
                type="button"
                :disabled="resourceCheck?.checking"
                :aria-busy="resourceCheck?.checking"
                @click="recheckResource"
              >
                {{
                  resourceCheck?.checking
                    ? t('movie.resource.checking')
                    : t(resourceCheck?.checkedAt ? 'movie.resource.recheck' : 'movie.resource.check')
                }}
              </button>
            </div>
          </div>
          <p v-if="resourceError" class="browse-error" role="alert">{{ resourceError }}</p>
          <p v-if="errorMessage" class="browse-error" role="alert">{{ errorMessage }}</p>
        </div>
      </div>
      <div class="detail-sections">
        <section>
          <p class="eyebrow">{{ t('movie.detail.storyEyebrow') }}</p>
          <h2>{{ t('movie.detail.story') }}</h2>
          <p class="overview">{{ movie.overview || t('movie.detail.overviewMissing') }}</p>
        </section>
        <section>
          <p class="eyebrow">{{ t('movie.detail.directorsEyebrow') }}</p>
          <h2>{{ t('movie.detail.directors') }}</h2>
          <div class="people-list">
            <div v-for="person in movie.directors" :key="person.tmdbId" class="person-card">
              <img v-if="person.profileUrl" :src="person.profileUrl" :alt="person.name" />
              <div v-else class="person-placeholder">{{ person.name.slice(0, 1) }}</div>
              <strong>{{ person.name }}</strong>
            </div>
            <p v-if="!movie.directors.length" class="muted-copy">{{ t('movie.detail.directorsMissing') }}</p>
          </div>
        </section>
        <section class="cast-section">
          <p class="eyebrow">{{ t('movie.detail.castEyebrow') }}</p>
          <h2>{{ t('movie.detail.cast') }}</h2>
          <div class="people-list">
            <div v-for="person in movie.cast" :key="`${person.tmdbId}-${person.character}`" class="person-card">
              <img v-if="person.profileUrl" :src="person.profileUrl" :alt="person.name" />
              <div v-else class="person-placeholder">{{ person.name.slice(0, 1) }}</div>
              <strong>{{ person.name }}</strong
              ><span>{{ person.character || t('movie.detail.characterMissing') }}</span>
            </div>
            <p v-if="!movie.cast.length" class="muted-copy">{{ t('movie.detail.castMissing') }}</p>
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
          :aria-busy="releasesLoading"
          tabindex="-1"
          @keydown="handleReleaseDialogKeydown"
        >
          <div class="release-panel-heading">
            <div>
              <p class="eyebrow">M-Team</p>
              <h2 id="release-dialog-title">{{ t('movie.releases.title') }}</h2>
            </div>
            <button ref="releaseCloseButton" class="text-button" type="button" @click="closeReleases()">
              {{ t('movie.releases.close') }}
            </button>
          </div>
          <div ref="releasePanelContent" class="release-panel-content">
            <p v-if="releasesLoading" class="muted-copy" role="status">{{ t('movie.releases.loading') }}</p>
            <p v-else-if="releasesError" class="browse-error" role="alert">{{ releasesError }}</p>
            <p v-else-if="!releases.length" class="muted-copy" role="status">{{ t('movie.releases.empty') }}</p>
            <ol v-else class="release-list">
              <li
                v-for="release in orderedReleases"
                :key="release.id"
                class="release-card"
                :class="downloadCardClass(release.id)"
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
                  <div v-if="release.audioCodec">
                    <dt>{{ t('movie.releases.audioCodec') }}</dt>
                    <dd>{{ release.audioCodec }}</dd>
                  </div>
                </dl>
                <div v-if="release.tags.length" class="release-tags">
                  <span v-for="tag in release.tags" :key="tag">{{ tag }}</span>
                </div>
                <div class="release-download-actions">
                  <span v-if="!canDownload(release.id)" class="muted-copy">{{ downloadUnavailable(release.id) }}</span>
                  <button
                    v-if="!downloadFor(release.id) || ['failed', 'missing'].includes(downloadFor(release.id)!.status)"
                    class="release-download-button"
                    type="button"
                    :disabled="!canDownload(release.id) || Boolean(submittingReleaseId)"
                    :title="canDownload(release.id) ? undefined : downloadUnavailable(release.id)"
                    @click="requestDownload(release)"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24">
                      <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" />
                    </svg>
                    {{
                      submittingReleaseId === release.id
                        ? t('movie.download.submitting')
                        : downloadFor(release.id)
                          ? t('movie.download.retry')
                          : t('movie.download.action')
                    }}
                  </button>
                </div>
                <div
                  v-if="submittingReleaseId === release.id"
                  class="release-download-progress downloading"
                  role="status"
                >
                  <div>
                    <span>{{ t('movie.download.submitting') }}</span>
                  </div>
                  <progress :aria-label="t('movie.download.submitting')"></progress>
                </div>
                <div
                  v-else-if="downloadFor(release.id)"
                  class="release-download-progress"
                  :class="{
                    downloading: downloadFor(release.id)!.status === 'downloading',
                    seeding: ['completed', 'seeding'].includes(downloadFor(release.id)!.status),
                  }"
                  role="status"
                >
                  <div>
                    <span
                      >{{ providerName(downloadFor(release.id)!.provider) }} ·
                      {{ downloadStatus(downloadFor(release.id)!) }}</span
                    >
                    <strong>{{ Math.round(downloadFor(release.id)!.progress) }}%</strong>
                  </div>
                  <progress
                    :value="downloadFor(release.id)!.progress"
                    max="100"
                    :aria-label="
                      t('movie.download.progress', { progress: Math.round(downloadFor(release.id)!.progress) })
                    "
                  ></progress>
                </div>
                <p v-if="downloadErrors[release.id]" class="browse-error" role="alert">
                  {{ downloadErrors[release.id] }}
                </p>
              </li>
            </ol>
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
                <label v-for="provider in downloadProviders" :key="provider" class="download-provider-option">
                  <input
                    v-model="selectedProvider"
                    type="radio"
                    name="download-provider"
                    :value="provider"
                    :disabled="
                      Boolean(
                        downloadFor(confirmingRelease.id) && downloadFor(confirmingRelease.id)!.provider !== provider,
                      )
                    "
                  />
                  <span>{{ providerName(provider) }}</span>
                </label>
              </fieldset>
              <p v-if="downloadFor(confirmingRelease.id)" class="download-retry-note">
                {{ t('movie.download.retryProvider') }}
              </p>
              <div class="download-confirm-actions">
                <button class="secondary" type="button" @click="cancelDownload">
                  {{ t('movie.download.cancel') }}
                </button>
                <button
                  class="primary"
                  type="button"
                  :disabled="!selectedProvider || Boolean(submittingReleaseId)"
                  @click="confirmDownload"
                >
                  {{ t('movie.download.confirm') }}
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
