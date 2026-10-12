<script setup lang="ts">
import type { ApiError, MyMoviesResponse, TrackedMovieStatus } from '@movie-hub/contract';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage } from '../../i18n/api-error';

const { apiBaseUrl } = loadWebConfig();
const { formatDate, locale, t } = useI18n();
const emit = defineEmits<{ openMovie: [tmdbId: number] }>();
const filter = ref<TrackedMovieStatus>('interested');
const result = ref<MyMoviesResponse | null>(null);
const loading = ref(true);
const errorMessage = ref('');
const skeletons = Array.from({ length: 5 }, (_, index) => index);
const failedPosters = ref(new Set<number>());
let requestController: AbortController | undefined;
const statusOptions = computed(() => [
  ['interested', t('movie.status.interested')],
  ['watched', t('movie.status.watched')],
  ['not_interested', t('movie.status.notInterested')],
] as const);
const activeStatusLabel = computed(() => statusOptions.value.find(([status]) => status === filter.value)?.[1] ?? '');
onMounted(() => void load());
onBeforeUnmount(() => requestController?.abort());
watch([filter, locale], () => void load());

async function load() {
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  loading.value = true; errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies?status=${filter.value}&page=1&pageSize=50&locale=${locale.value}`, {
      credentials: 'include',
      signal: controller.signal,
    });
    const body = await response.json() as MyMoviesResponse | ApiError;
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
  const check = movie.resourceCheck;
  if (!check) return '';
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
</script>

<template>
  <section class="movie-section" aria-labelledby="my-movies-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">{{ t('myMovies.eyebrow') }}</p>
        <h1 id="my-movies-title">{{ t('myMovies.title') }}</h1>
        <p class="section-description">{{ t('myMovies.description') }}</p>
      </div>
    </div>
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
      <article
        v-for="movie in result.items"
        :key="movie.tmdbId"
        class="movie-card clickable"
        role="listitem"
      >
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
            <div v-else class="poster-placeholder" role="img" :aria-label="t('a11y.moviePosterUnavailable', { title: movie.title })">
              <span aria-hidden="true">{{ t('movie.posterUnavailable') }}</span>
            </div>
            <div class="poster-interface" aria-hidden="true">
              <span class="interface-code">LIBRARY / {{ movie.tmdbId }}</span>
              <span class="interface-action">{{ t('movie.openDetails') }} <b>↗</b></span>
            </div>
          </div>
          <div class="movie-copy">
            <h2>{{ movie.title }}</h2>
            <p class="original-title" :class="{ placeholder: !movie.originalTitle || movie.originalTitle === movie.title }" :aria-hidden="!movie.originalTitle || movie.originalTitle === movie.title">
              {{ movie.originalTitle && movie.originalTitle !== movie.title ? movie.originalTitle : '\u00a0' }}
            </p>
            <div class="movie-meta">
              <span>
                <span class="sr-only">{{ t('a11y.releaseDate') }}: </span>
                <time v-if="movie.releaseDate" :datetime="movie.releaseDate">{{ releaseDateLabel(movie.releaseDate) }}</time>
                <span v-else>{{ releaseDateLabel() }}</span>
              </span>
              <span class="status-badge" :data-status="movie.userStatus">
                <span class="sr-only">{{ t('a11y.movieStatusLabel') }}: </span>{{ statusOptions.find(([status]) => status === movie.userStatus)?.[1] }}
              </span>
            </div>
            <p
              v-if="movie.resourceCheck"
              class="resource-status"
              :class="{ error: movie.resourceCheck.lastAttemptStatus === 'error' }"
              role="status"
            >
              {{ resourceStatusLabel(movie) }}
            </p>
          </div>
        </a>
      </article>
    </div>
  </section>
</template>
