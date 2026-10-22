<script setup lang="ts">
import type { IntegrationPreferences, ApiError, MovieResourceSyncBatch, MyMoviesResponse, MyMoviesFilter } from '@movie-hub/contract';
import ResourceSiteSelector from './ResourceSiteSelector.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const { formatDate, locale, t } = useI18n();
const emit = defineEmits<{ openMovie: [tmdbId: number] }>();
const filter = ref<MyMoviesFilter>('interested');
const result = ref<MyMoviesResponse | null>(null);
const loading = ref(true);
const errorMessage = ref('');
const syncError = ref('');
const syncBatch = ref<MovieResourceSyncBatch | null>(null);
const mteamStatus = ref<'loading' | 'configured' | 'unconfigured' | 'unknown'>('loading');
const skeletons = Array.from({ length: 5 }, (_, index) => index);
const failedPosters = ref(new Set<number>());
let requestController: AbortController | undefined;
let syncPoll: number | undefined;
let syncDismissTimer: number | undefined;
const syncJobStorageKey = 'movie-hub:mteam-sync-job';
const statusOptions = computed(() => {
  return [
    ['interested', t('movie.status.interested')],
    ['watched', t('movie.status.watched')],
    ['liked', t('movie.preference.liked')],
    ['disliked', t('movie.preference.disliked')],
  ] as const;
});
const activeStatusLabel = computed(() => {
  return statusOptions.value.find(([status]) => status === filter.value)?.[1] ?? '';
});
onMounted(() => {
  void load();

  void loadSyncBatch();
});
onBeforeUnmount(() => {
  requestController?.abort();
  stopSyncPolling();
  stopSyncDismissTimer();
});
watch([filter, locale], () => void load());

async function load() {
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  loading.value = true;
  errorMessage.value = '';
  try {
    const response = await fetch(
      `${apiBaseUrl}/me/movies?status=${filter.value}&page=1&pageSize=50&locale=${locale.value}`,
      {
        credentials: 'include',
        signal: controller.signal,
      }
    );
    const body = (await response.json()) as MyMoviesResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.loadMyMovies');
    result.value = body as MyMoviesResponse;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      errorMessage.value = localizedErrorMessage(error, 'errors.loadMyMovies');
    }
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

function releaseDateLabel(releaseDate?: string): string {
  return releaseDate
    ? formatDate(releaseDate, { dateStyle: 'medium', timeZone: 'UTC' })
    : t('movie.releaseDateUnknown');
}

function markPosterFailed(tmdbId: number) {
  failedPosters.value = new Set(failedPosters.value).add(tmdbId);
}

function resourceStatusLabel(movie: MyMoviesResponse['items'][number]): string {
  if (mteamStatus.value === 'unconfigured') return t('resourceSelection.none');
  const check = movie.resourceCheck;
  if (!check) return '';
  if (check.incomplete && check.availability === 'available') return t('resourceSelection.availablePartial');
  if (check.checking) return t('movie.resource.checking');
  if (check.incomplete) return t('resourceSelection.incomplete');
  if (check.lastAttemptStatus === 'error') {
    if (!check.checkedAt) return t('movie.resource.checkFailed');
    if (check.availability === 'available') return t('movie.resource.availableRefreshFailed');
    if (check.availability === 'unavailable') return t('movie.resource.unavailableRefreshFailed');
    return t('movie.resource.checkFailed');
  }
  if (check.availability === 'available') return t('resourceSelection.available');
  if (check.availability === 'unavailable') return t('movie.resource.unavailable');
  if (check.availability === 'unmatchable') return t('movie.resource.unmatchable');
  return t('movie.resource.pending');
}

function successfulCheckTime(movie: MyMoviesResponse['items'][number]): string {
  const checkedAt = movie.resourceCheck?.checkedAt;
  return checkedAt
    ? t('movie.resource.lastSuccessfulCheck', {
        date: formatDate(checkedAt, { dateStyle: 'medium', timeStyle: 'short' }),
      })
    : '';
}

function preferencesLoaded(preferences: IntegrationPreferences) {
  mteamStatus.value = preferences.effectiveSites.length ? 'configured' : 'unconfigured';
}
function preferencesChanged(preferences: IntegrationPreferences) {
  preferencesLoaded(preferences);
  void load();
}

async function startSync() {
  if (isSyncActive(syncBatch.value)) return;
  stopSyncDismissTimer();
  syncError.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/resources/sync`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = (await response.json()) as MovieResourceSyncBatch | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.syncMovieResources');
    syncBatch.value = body as MovieResourceSyncBatch;
    window.localStorage.setItem(syncJobStorageKey, syncBatch.value.id);
    if (isSyncActive(syncBatch.value)) scheduleSyncPoll();
    else {
      window.localStorage.removeItem(syncJobStorageKey);
      scheduleSyncDismiss();
      await load();
    }
  } catch (error) {
    syncError.value = localizedErrorMessage(error, 'errors.syncMovieResources');
  }
}

async function loadSyncBatch() {
  try {
    const jobId = syncBatch.value?.id ?? window.localStorage.getItem(syncJobStorageKey);
    if (!jobId) return;
    const response = await fetch(`${apiBaseUrl}/me/movies/resources/sync/${jobId}`, { credentials: 'include' });
    const body = (await response.json()) as MovieResourceSyncBatch | ApiError | null;
    if (!response.ok) throw localizedApiError(body, 'errors.syncMovieResources');
    const wasActive = isSyncActive(syncBatch.value);
    syncBatch.value = isSyncBatch(body) ? body : null;
    if (isSyncActive(syncBatch.value)) {
      stopSyncDismissTimer();
      scheduleSyncPoll();
    } else {
      stopSyncPolling();
      window.localStorage.removeItem(syncJobStorageKey);
      if (syncBatch.value) scheduleSyncDismiss();
      if (wasActive) await load();
    }
  } catch (error) {
    syncError.value = localizedErrorMessage(error, 'errors.syncMovieResources');
    stopSyncPolling();
  }
}

function isSyncActive(batch: MovieResourceSyncBatch | null): boolean {
  return Boolean(batch && ['queued', 'running', 'paused'].includes(batch.status));
}

function isSyncBatch(value: unknown): value is MovieResourceSyncBatch {
  return Boolean(value && typeof value === 'object' && 'id' in value && 'status' in value && 'total' in value);
}

function scheduleSyncPoll() {
  stopSyncPolling();
  syncPoll = window.setTimeout(() => void loadSyncBatch(), 1_000);
}

function stopSyncPolling() {
  if (syncPoll !== undefined) window.clearTimeout(syncPoll);
  syncPoll = undefined;
}

function scheduleSyncDismiss() {
  stopSyncDismissTimer();
  syncDismissTimer = window.setTimeout(dismissSyncProgress, 10_000);
}

function stopSyncDismissTimer() {
  if (syncDismissTimer !== undefined) window.clearTimeout(syncDismissTimer);
  syncDismissTimer = undefined;
}

function dismissSyncProgress() {
  if (isSyncActive(syncBatch.value)) return;
  stopSyncDismissTimer();
  window.localStorage.removeItem(syncJobStorageKey);
  syncBatch.value = null;
}

function syncStatusLabel(batch: MovieResourceSyncBatch): string {
  if (batch.needsAction === 'update_api_key') return t('myMovies.sync.updateApiKey');
  const keys = {
    queued: 'myMovies.sync.status.queued',
    running: 'myMovies.sync.status.running',
    paused: 'myMovies.sync.status.paused',
    completed: 'myMovies.sync.status.completed',
    failed: 'myMovies.sync.status.failed',
    cancelled: 'myMovies.sync.status.cancelled',
  } as const;
  return t(keys[batch.status]);
}
</script>

<template>
  <section class="movie-section" aria-labelledby="my-movies-title">
    <div class="section-heading">
      <div class="my-movies-heading-copy">
        <p class="eyebrow">{{ t('myMovies.eyebrow') }}</p>
        <div class="my-movies-title-line">
          <h1 id="my-movies-title">{{ t('myMovies.title') }}</h1>
          <p class="section-description">{{ t('myMovies.description') }}</p>
        </div>
      </div>
      <div class="resource-batch-controls">
    <ResourceSiteSelector :disabled="isSyncActive(syncBatch)" @loaded="preferencesLoaded" @changed="preferencesChanged" />
      <button
        v-if="mteamStatus !== 'unconfigured'"
        class="resource-sync-button"
        type="button"
        :disabled="isSyncActive(syncBatch)"
        :aria-label="isSyncActive(syncBatch) ? t('myMovies.sync.inProgress') : t('myMovies.sync.start')"
        :aria-busy="isSyncActive(syncBatch)"
        :data-tooltip="isSyncActive(syncBatch) ? t('myMovies.sync.inProgress') : t('myMovies.sync.tooltip')"
        @click="startSync"
      >
        <svg
          class="resource-sync-icon"
          :class="{ spinning: isSyncActive(syncBatch) }"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M19 4.5v4h-4" />
          <path d="M19 8.5a8 8 0 1 0 .8 5.5" />
        </svg>
        <span class="sr-only">
          {{ isSyncActive(syncBatch) ? t('myMovies.sync.inProgress') : t('myMovies.sync.start') }}
        </span>
      </button>
      </div>
    </div>
    <p v-if="mteamStatus === 'unconfigured'" class="integration-guidance" role="status">
      <span>{{ t('resourceSelection.none') }}</span>
      <a href="/settings">{{ t('resourceSelection.configure') }}</a>
    </p>
    <section v-if="syncBatch" class="sync-progress" :aria-label="t('myMovies.sync.progressLabel')" aria-live="polite">
      <div class="sync-progress-heading">
        <strong>{{ syncStatusLabel(syncBatch) }}</strong>
        <div class="sync-progress-meta">
          <span>{{ syncBatch.completed }} / {{ syncBatch.total }}</span>
          <button
            v-if="!isSyncActive(syncBatch)"
            type="button"
            :aria-label="t('myMovies.sync.dismiss')"
            :title="t('myMovies.sync.dismiss')"
            @click="dismissSyncProgress"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </div>
      <progress :max="Math.max(syncBatch.total, 1)" :value="syncBatch.completed"></progress>
      <dl>
        <div>
          <dt>{{ t('myMovies.sync.available') }}</dt>
          <dd>{{ syncBatch.available }}</dd>
        </div>
        <div>
          <dt>{{ t('myMovies.sync.unavailable') }}</dt>
          <dd>{{ syncBatch.unavailable }}</dd>
        </div>
        <div>
          <dt>{{ t('myMovies.sync.unmatchable') }}</dt>
          <dd>{{ syncBatch.unmatchable }}</dd>
        </div>
        <div>
          <dt>{{ t('myMovies.sync.failed') }}</dt>
          <dd>{{ syncBatch.failed }}</dd>
        </div>
      </dl>
    </section>
    <p v-if="syncError" class="browse-error" role="alert">{{ syncError }}</p>
    <div class="filter-tabs" role="group" :aria-label="t('myMovies.filterLabel')">
      <button
        v-for="option in statusOptions"
        :key="option[0]"
        type="button"
        :class="{ active: filter === option[0] }"
        :aria-pressed="filter === option[0]"
        @click="filter = option[0]"
      >
        {{ option[1] }}
      </button>
    </div>
    <div v-if="loading" class="skeleton-grid" role="status" :aria-label="t('status.loadingMyMovies')">
      <div v-for="item in skeletons" :key="item" class="skeleton-card" aria-hidden="true">
        <div class="skeleton-poster"></div>
        <div class="skeleton-line wide"></div>
        <div class="skeleton-line"></div>
      </div>
    </div>
    <div v-else-if="errorMessage" class="movie-state" role="alert">
      <p>{{ errorMessage }}</p>
      <button class="outline-button" type="button" @click="load">{{ t('actions.retry') }}</button>
    </div>
    <div v-else-if="!result?.items.length" class="movie-state empty-library">
      <span class="empty-state-mark" aria-hidden="true">＋</span>
      <h2>{{ t('empty.myMoviesTitle', { status: activeStatusLabel }) }}</h2>
      <p>{{ t('empty.myMoviesDescription', { status: activeStatusLabel }) }}</p>
    </div>
    <div v-else class="movie-grid" role="list" :aria-label="t('myMovies.resultsLabel', { status: activeStatusLabel })">
      <article v-for="movie in result.items" :key="movie.tmdbId" class="movie-card clickable" role="listitem">
        <a
          class="movie-card-link"
          :href="`/movies/${movie.tmdbId}`"
          :aria-label="t('a11y.viewMovieDetails', { title: movie.title })"
          @click.prevent="emit('openMovie', movie.tmdbId)"
        >
          <div class="poster-frame">
            <img
              v-if="movie.posterUrl && !failedPosters.has(movie.tmdbId)"
              :src="movie.posterUrl"
              :alt="t('a11y.moviePoster', { title: movie.title })"
              loading="lazy"
              @error="markPosterFailed(movie.tmdbId)"
            />
            <div
              v-else
              class="poster-placeholder"
              role="img"
              :aria-label="t('a11y.moviePosterUnavailable', { title: movie.title })"
            >
              <span aria-hidden="true">{{ t('movie.posterUnavailable') }}</span>
            </div>
            <div class="poster-interface" aria-hidden="true">
              <span class="interface-code">LIBRARY / {{ movie.tmdbId }}</span>
              <span class="interface-action">{{ t('movie.openDetails') }} <b>↗</b></span>
            </div>
          </div>
          <div class="movie-copy">
            <h2>{{ movie.title }}</h2>
            <p
              class="original-title"
              :class="{ placeholder: !movie.originalTitle || movie.originalTitle === movie.title }"
              :aria-hidden="!movie.originalTitle || movie.originalTitle === movie.title"
            >
              {{ movie.originalTitle && movie.originalTitle !== movie.title ? movie.originalTitle : '\u00a0' }}
            </p>
            <div class="movie-meta">
              <span>
                <span class="sr-only">{{ t('a11y.releaseDate') }}: </span>
                <time v-if="movie.releaseDate" :datetime="movie.releaseDate">{{
                  releaseDateLabel(movie.releaseDate)
                }}</time>
                <span v-else>{{ releaseDateLabel() }}</span>
              </span>
              <span class="status-badge" :data-status="filter">
                <span class="sr-only">{{ t('a11y.movieStatusLabel') }}: </span>{{ activeStatusLabel }}
              </span>
            </div>
            <div
              v-if="movie.resourceCheck || (mteamStatus === 'unconfigured' && movie.userStatus === 'interested')"
              class="resource-summary"
            >
              <p
                class="resource-status"
                :class="{
                  error: movie.resourceCheck?.lastAttemptStatus === 'error' && !movie.resourceCheck?.checking,
                }"
                role="status"
              >
                {{ resourceStatusLabel(movie) }}
              </p>
              <p v-if="successfulCheckTime(movie)" class="resource-checked-at">
                {{ successfulCheckTime(movie) }}
              </p>
            </div>
          </div>
        </a>
      </article>
    </div>
  </section>
</template>
