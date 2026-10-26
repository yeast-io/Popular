<script setup lang="ts">
import ResourceNotificationButton from '../resource-notifications/ResourceNotificationButton.vue';
import ResourceNotificationFeedback from '../resource-notifications/ResourceNotificationFeedback.vue';
import type { ResourceNotificationFeedback as ResourceNotificationFeedbackState } from '../resource-notifications/resource-notification.types';
import type { IntegrationPreferences, ApiError, MovieDetail, MovieRelease, MovieResourceCheckResponse, MovieStatus, TrackedMovieStatus } from '@movie-hub/contract';
import ResourceSiteRefresh from '../resource-search/ResourceSiteRefresh.vue';
import ResourceReleaseFilter from '../resource-search/ResourceReleaseFilter.vue';
import { useResourceDownloads } from '../resource-search/resource-download.client';
import ResourceDownloadActions from '../resource-search/ResourceDownloadActions.vue';
import ResourceDownloadChoice from '../resource-search/ResourceDownloadChoice.vue';
import type { MovieSiteReleaseGroup } from './movie-site-releases.types';
import { resourceSiteIconStyle } from './resource-site.presentation';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { LocalizedApiError, localizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const resourceNotificationFeedback = ref<ResourceNotificationFeedbackState | null>(null);
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
const selectedReleaseTags = ref<Record<string, string[]>>({});
let releaseGeneration = 0;
let resourceGeneration = 0;
let preferencesGeneration = 0;
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
let devicePoll: ReturnType<typeof setInterval> | undefined;
let requestController: AbortController | undefined;
let resourcePoll: number | undefined;
let releaseTrigger: HTMLElement | null = null;
let trailerTrigger: HTMLElement | null = null;
let previousBodyOverflow = '';
let pageScrollLocked = false;
const resourceDownloads = useResourceDownloads({
  tmdbId: () => props.tmdbId, authenticated: () => props.authenticated, generation: () => releaseGeneration,
  preferences: integrationPreferences, open: releasesOpen, panel: releasePanelContent, activeRelease: activeDownloadReleaseId,
});
const { downloads, loadDownloadSnapshot, loadDownloadProviders, loadRemoteDevices, loadDownloads,
  stopDownloadPolling, handleVisibilityChange, confirmingRelease, cancelDownload, downloadChoiceDialog,
  downloadKey, downloadCardClass } = resourceDownloads;
const detailStyle = computed(() => {
  const hue = 14 + (props.tmdbId % 4) * 11;
  return { '--movie-accent': `hsl(${hue} 88% 58%)`, '--movie-accent-rgb': hue < 30 ? '242, 82, 45' : '242, 151, 45' };
});
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
  window.addEventListener('integration-preferences-changed', preferencesChanged);
  if (props.authenticated) {
    void loadIntegrationPreferences();
    void loadResourceCheck();
    void loadDownloadSnapshot();
  }
  devicePoll = setInterval(() => {
    if (releasesOpen.value && props.authenticated) void loadRemoteDevices();
  }, 60_000);
  document.addEventListener('visibilitychange', handleVisibilityChange);
});
onBeforeUnmount(() => {
  window.removeEventListener('integration-preferences-changed', preferencesChanged);
  ++preferencesGeneration;
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
      void loadIntegrationPreferences();
      void loadResourceCheck();
      void loadDownloadSnapshot();
    } else {
      ++resourceGeneration;
      closeReleases(false);
      resourceCheck.value = null;
      ++preferencesGeneration;
      integrationPreferences.value = null;
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

async function loadIntegrationPreferences() {
  const generation = ++preferencesGeneration;
  try {
    const response = await fetch(`${apiBaseUrl}/me/integration-preferences`, {
      credentials: 'include', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw await localizedResponseError(response);
    const preferences = await response.json() as IntegrationPreferences;
    if (generation === preferencesGeneration && props.authenticated) integrationPreferences.value = preferences;
  } catch (error) {
    if (generation === preferencesGeneration && props.authenticated)
      resourceError.value = localizedErrorMessage(error, 'errors.requestFailed');
  }
}
function preferencesChanged() {
  integrationPreferences.value = null;
  closeReleases(false);
  if (props.authenticated) {
    void loadIntegrationPreferences();
    void loadResourceCheck();
  }
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
    if (!response.ok) throw await localizedResponseError(response, 'errors.loadMovieReleases');
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
    if (generation === releaseGeneration && !(error instanceof DOMException && error.name === 'AbortError')) {
      if (error instanceof LocalizedApiError && error.code === 'RESOURCE_REFRESH_RATE_LIMITED' && error.retryAfterSeconds !== undefined)
        group.refreshAvailableAt = Date.now() + error.retryAfterSeconds * 1000;
      else group.error = localizedErrorMessage(error, 'errors.loadMovieReleases');
    }
  } finally { if (generation === releaseGeneration) group.loading = false; }
}
async function refreshReleaseGroup(group: MovieSiteReleaseGroup) {
  if (group.loading) return;
  const generation = releaseGeneration;
  await loadReleaseGroup(group, false, true);
  if (generation === releaseGeneration && releasesOpen.value) await loadResourceCheck();
}
function resourceActionLabel() {
  return t(resourceCheck.value?.checking
    ? 'movie.resource.checking'
    : resourceCheck.value?.availability === 'available' ? 'resourceSelection.viewResources' : 'resourceSelection.query');
}
function resourceAction() {
  if (releasesLoading.value || resourceCheck.value?.checking) return;
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
  selectedReleaseTags.value = {};
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
      const preferences = await response.json() as IntegrationPreferences;
      if (generation !== releaseGeneration || !props.authenticated) return;
      integrationPreferences.value = preferences;
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
          <button v-if="authenticated" class="poster-resource-badge"
            :class="`is-${posterDownloadState ?? posterResourceState()}`" type="button"
            :aria-label="`${resourceStatusLabel()} · ${resourceActionLabel()}`" :title="resourceActionLabel()"
            :disabled="releasesLoading || resourceCheck?.checking" @click="resourceAction">
            <span class="poster-resource-dot" aria-hidden="true"></span>
            <span>{{ posterDownloadState ? t(`movie.download.badge.${posterDownloadState}`) : posterResourceLabel() }}</span>
          </button>
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
          <dl class="dossier-data" :class="{ 'has-resource-status': authenticated }">
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
            <div v-if="authenticated" class="dossier-resource">
              <dt>{{ t('movie.detail.resources') }}</dt>
              <dd>
                <button class="poster-resource-badge dossier-resource-button resource-status-button" type="button"
                  :class="`is-${posterResourceState()}`" :disabled="releasesLoading || resourceCheck?.checking"
                  :aria-label="`${resourceStatusLabel()} · ${resourceActionLabel()}`" :title="resourceActionLabel()"
                  @click="resourceAction">
                  <span class="poster-resource-dot" aria-hidden="true"></span><span>{{ posterResourceLabel() }}</span>
                </button>
              </dd>
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
            <ResourceNotificationButton media-type="movie" :tmdb-id="props.tmdbId" :authenticated="!!props.authenticated" @feedback="resourceNotificationFeedback = $event" @require-login="emit('requireLogin')" />
            <button class="detail-state-icon watched-icon" type="button" :class="{ active: movie.userStatus === 'watched' }"
              :aria-pressed="movie.userStatus === 'watched'" :disabled="updating"
              :aria-label="t(movie.userStatus === 'watched' ? 'movie.status.markUnwatched' : 'movie.status.markWatched')"
              :aria-describedby="`${statusTooltipId}-watched`" @click="setStatus('watched')">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /><path v-if="movie.userStatus !== 'watched'" d="m3 3 18 18" /></svg>
              <span :id="`${statusTooltipId}-watched`" class="detail-state-tooltip" role="tooltip">{{ t(movie.userStatus === 'watched' ? 'movie.status.watched' : 'movie.status.unwatched') }}</span>
            </button>
          </div>
          </div>
          <ResourceNotificationFeedback :feedback="resourceNotificationFeedback" />
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
          :style="{ '--resource-artwork': movie?.backdropUrl || movie?.posterUrl ? `url(${JSON.stringify(movie?.backdropUrl || movie?.posterUrl)})` : undefined }"
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
                <strong class="release-site-identity">
                  <span class="resource-site-outline" :style="resourceSiteIconStyle(group.site)" aria-hidden="true" />
                  {{ group.name }}
                </strong>
                <span v-if="integrationPreferences?.defaults.resource === group.site" class="integration-default-badge">{{ t('integrationDefaults.default') }}</span>
                <span v-if="group.loading" class="release-site-status">{{ t('movie.releases.loading') }}</span>
                <span v-else-if="group.error" class="release-site-status">{{ t('movie.resource.checkFailed') }}</span>
                <span v-else class="release-site-status" />
                <button type="button" class="release-site-reset" @click.stop.prevent="selectedReleaseTags[group.site] = []">{{ t('resourceFilters.reset') }}</button>
                <ResourceSiteRefresh :site="group.site" :name="group.name" :loading="group.loading" :retry-at="group.refreshAvailableAt" :count="group.result?.releases.length" @refresh="refreshReleaseGroup(group)" />
              </summary>
              <div class="release-site-content" :aria-busy="group.loading">
                <p v-if="group.loading && !group.result" role="status">{{ t('movie.releases.loading') }}</p>
                <p v-if="group.error" class="browse-error" role="alert">{{ group.error }} <button type="button" class="text-button" :disabled="group.loading" @click="refreshReleaseGroup(group)">{{ t('actions.retry') }}</button></p>
                <p v-if="group.result" class="release-query-time">
                  {{ t(group.error ? 'resourceSelection.staleResults' : group.result.cached ? 'resourceSelection.cachedAt' : 'resourceSelection.queriedAt', { date: formatDate(group.result.queriedAt, { dateStyle: 'short', timeStyle: 'short' }) }) }}
                  <span v-if="group.result.cacheExpiresAt"> · {{ t('resourceSelection.cacheExpiresAt', { date: formatDate(group.result.cacheExpiresAt, { dateStyle: 'short', timeStyle: 'short' }) }) }}</span>
                </p>
                <p v-if="group.result && !group.result.releases.length && !group.loading" class="muted-copy">{{ t(group.result.availability === 'unmatchable' ? 'movie.resource.unmatchable' : 'movie.releases.empty') }}</p>
            <ResourceReleaseFilter :selected="selectedReleaseTags[group.site] ?? []" @update:selected="selectedReleaseTags[group.site] = $event" v-slot="{ releases: filteredReleases }" :releases="group.result ? orderedGroupReleases(group) : []" :loading="group.loading">
            <ol v-if="filteredReleases.length" class="release-list">
              <li
                v-for="release in filteredReleases"
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
                <ResourceDownloadActions :controller="resourceDownloads" :release="release" :site="group.site" :supports-download="group.supportsDownload" />
              </li>
            </ol>
            </ResourceReleaseFilter>
                <button v-if="group.result?.nextPage" type="button" class="text-button" :disabled="group.loading" @click="loadReleaseGroup(group, true)">{{ t('resourceSelection.loadMore') }}</button>
              </div>
            </details>
          </div>
          <ResourceDownloadChoice :controller="resourceDownloads" />
        </section>
      </div>
    </Teleport>
  </section>
</template>
