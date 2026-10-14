<script setup lang="ts">
import type { ApiError, MoviePreference, MovieStatus, MovieSummary, SearchMoviesResponse, TrackedMoviePreference, TrackedMovieStatus, TrendingMoviesResponse } from '@movie-hub/contract';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const props = defineProps<{ authenticated: boolean }>();
const emit = defineEmits<{ requireLogin: []; openMovie: [tmdbId: number] }>();
const { apiBaseUrl } = loadWebConfig();
const { formatDate, formatNumber, locale, t } = useI18n();
const movies = ref<MovieSummary[]>([]);
const query = ref('');
const page = ref(1);
const hasMore = ref(false);
const loading = ref(true);
const loadingMore = ref(false);
const errorMessage = ref('');
const fetchedAt = ref('');
const trendingGeneration = ref('');
const skeletons = Array.from({ length: 10 }, (_, index) => index);
const failedPosters = ref(new Set<number>());
const updating = ref(new Set<number>());
const loadedLocale = ref<string | null>(null);
const loadedQuery = ref('');
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let requestController: AbortController | undefined;
let requestGeneration = 0;

const searching = computed(() => query.value.trim().length > 0);
const canLoadMore = computed(() => hasMore.value
  && !loading.value
  && !loadingMore.value
  && loadedLocale.value === locale.value
  && loadedQuery.value === query.value.trim());
const freshness = computed(() => fetchedAt.value && !searching.value
  ? formatDate(fetchedAt.value, { dateStyle: 'medium', timeStyle: 'short' })
  : '');
const statusOptions = computed(() => [
  ['watched', t('movie.status.watched')],
  ['interested', t('movie.status.interested')],
] as const);
const browserTitle = computed(() => searching.value
  ? t('discover.searchTitle', { query: query.value.trim() })
  : t('discover.trendingTitle'));

onMounted(() => void loadFirstPage());
onBeforeUnmount(() => {
  requestGeneration += 1;
  if (debounceTimer) clearTimeout(debounceTimer);
  requestController?.abort();
});

watch([query, locale], () => {
  const generation = ++requestGeneration;
  if (debounceTimer) clearTimeout(debounceTimer);
  requestController?.abort();
  movies.value = [];
  page.value = 1;
  hasMore.value = false;
  loading.value = true;
  loadingMore.value = false;
  errorMessage.value = '';
  fetchedAt.value = '';
  trendingGeneration.value = '';
  loadedLocale.value = null;
  loadedQuery.value = '';
  debounceTimer = setTimeout(() => void loadFirstPage(generation), 300);
}, { flush: 'sync' });

async function loadFirstPage(generation = ++requestGeneration) {
  if (generation !== requestGeneration) return;
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  loading.value = true;
  errorMessage.value = '';
  const requestedLocale = locale.value;
  const term = query.value.trim();
  try {
    if (term) {
      const result = await request<SearchMoviesResponse>(`${apiBaseUrl}/movies/search?query=${encodeURIComponent(term)}&page=1&locale=${requestedLocale}`, { signal: controller.signal });
      if (generation !== requestGeneration || controller.signal.aborted) return;
      applySearch(result, false);
    } else {
      const result = await request<TrendingMoviesResponse>(`${apiBaseUrl}/movies/trending?page=1&locale=${requestedLocale}`, { signal: controller.signal });
      if (generation !== requestGeneration || controller.signal.aborted) return;
      applyTrending(result, false);
    }
    loadedLocale.value = requestedLocale;
    loadedQuery.value = term;
  } catch (error) {
    if (generation === requestGeneration && !(error instanceof DOMException && error.name === 'AbortError')) {
      errorMessage.value = messageFor(error);
    }
  } finally {
    if (generation === requestGeneration && !controller.signal.aborted) loading.value = false;
  }
}

async function loadMore() {
  if (!canLoadMore.value) return;
  const generation = requestGeneration;
  const requestedLocale = locale.value;
  const term = query.value.trim();
  const currentPage = page.value;
  loadingMore.value = true;
  errorMessage.value = '';
  try {
    if (term) {
      const result = await request<SearchMoviesResponse>(`${apiBaseUrl}/movies/search?query=${encodeURIComponent(term)}&page=${currentPage + 1}&locale=${requestedLocale}`);
      if (generation !== requestGeneration) return;
      applySearch(result, true);
    } else {
      const result = await request<TrendingMoviesResponse>(`${apiBaseUrl}/movies/trending/load-more`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: currentPage, generation: trendingGeneration.value, locale: requestedLocale }),
      });
      if (generation !== requestGeneration) return;
      applyTrending(result, true);
    }
  } catch (error) {
    if (generation === requestGeneration) errorMessage.value = messageFor(error);
  } finally {
    if (generation === requestGeneration) loadingMore.value = false;
  }
}

async function setStatus(movie: MovieSummary, status: TrackedMovieStatus) {
  if (!props.authenticated) { emit('requireLogin'); return; }
  if (updating.value.has(movie.tmdbId)) return;
  const previous = movie.userStatus;
  const next: MovieStatus = previous === status ? 'unwatched' : status;
  movie.userStatus = next;
  updating.value = new Set(updating.value).add(movie.tmdbId);
  errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${movie.tmdbId}/status`, {
      method: next === 'unwatched' ? 'DELETE' : 'PUT', credentials: 'include',
      ...(next === 'unwatched' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: next }) }),
    });
    if (!response.ok) throw await localizedResponseError(response);
  } catch (error) {
    movie.userStatus = previous;
    errorMessage.value = localizedErrorMessage(error, 'errors.saveMovieStatus');
  } finally {
    const pending = new Set(updating.value); pending.delete(movie.tmdbId); updating.value = pending;
  }
}

async function setPreference(movie: MovieSummary, preference: TrackedMoviePreference) {
  if (!props.authenticated) { emit('requireLogin'); return; }
  if (updating.value.has(movie.tmdbId)) return;
  const previous = movie.userPreference;
  const next: MoviePreference = previous === preference ? 'neutral' : preference;
  movie.userPreference = next;
  updating.value = new Set(updating.value).add(movie.tmdbId);
  errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${movie.tmdbId}/preference`, {
      method: next === 'neutral' ? 'DELETE' : 'PUT', credentials: 'include',
      ...(next === 'neutral' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preference: next }) }),
    });
    if (!response.ok) throw await localizedResponseError(response);
  } catch (error) {
    movie.userPreference = previous;
    errorMessage.value = localizedErrorMessage(error, 'errors.saveMoviePreference');
  } finally {
    const pending = new Set(updating.value); pending.delete(movie.tmdbId); updating.value = pending;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  const result = await response.json() as T | ApiError;
  if (!response.ok) {
    const apiError = result as ApiError;
    throw localizedApiError(apiError, 'errors.requestFailed');
  }
  return result as T;
}

function applyTrending(result: TrendingMoviesResponse, append: boolean) {
  movies.value = append ? mergeUniqueMovies(movies.value, result.items) : result.items;
  page.value = result.page; hasMore.value = result.hasMore; fetchedAt.value = result.fetchedAt; trendingGeneration.value = result.generation;
}
function applySearch(result: SearchMoviesResponse, append: boolean) {
  movies.value = append ? mergeUniqueMovies(movies.value, result.items) : result.items;
  page.value = result.page; hasMore.value = result.hasMore; fetchedAt.value = ''; trendingGeneration.value = '';
}
function mergeUniqueMovies(current: MovieSummary[], incoming: MovieSummary[]): MovieSummary[] {
  const seen = new Set(current.map(({ tmdbId }) => tmdbId));
  const merged = [...current];
  for (const movie of incoming) {
    if (seen.has(movie.tmdbId)) continue;
    seen.add(movie.tmdbId);
    merged.push(movie);
  }
  return merged;
}
function markPosterFailed(tmdbId: number) { failedPosters.value = new Set(failedPosters.value).add(tmdbId); }
function releaseDateLabel(releaseDate?: string): string {
  return releaseDate
    ? formatDate(releaseDate, { dateStyle: 'medium', timeZone: 'UTC' })
    : t('movie.releaseDateUnknown');
}
function ratingLabel(rating: number): string {
  return formatNumber(rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function messageFor(error: unknown): string {
  return localizedErrorMessage(error, 'errors.loadMovies');
}
</script>

<template>
  <section class="movie-section" aria-labelledby="movie-browser-title">
    <div class="browser-toolbar">
      <div>
        <p class="eyebrow">{{ t('discover.eyebrow') }}</p>
        <h2 id="movie-browser-title">{{ browserTitle }}</h2>
      </div>
      <label class="search-box">
        <span class="sr-only">{{ t('discover.searchLabel') }}</span>
        <input v-model="query" type="search" maxlength="100" :placeholder="t('discover.searchPlaceholder')" autocomplete="off" />
      </label>
    </div>
    <p v-if="freshness" class="freshness">{{ t('status.updatedAt', { date: freshness }) }}</p>
    <div v-if="loading" class="skeleton-grid" role="status" :aria-label="t(searching ? 'status.searchingMovies' : 'status.loadingTrending')">
      <div v-for="item in skeletons" :key="item" class="skeleton-card" aria-hidden="true">
        <div class="skeleton-poster"></div>
        <div class="skeleton-line wide"></div>
        <div class="skeleton-line"></div>
      </div>
    </div>
    <div v-else-if="movies.length === 0" class="movie-state">
      <p>{{ errorMessage || t(searching ? 'empty.searchResults' : 'empty.trendingMovies') }}</p>
      <button v-if="errorMessage" class="outline-button" type="button" @click="loadFirstPage()">{{ t('actions.retry') }}</button>
    </div>
    <template v-else>
      <p v-if="errorMessage" class="browse-error" role="alert">{{ errorMessage }}</p>
      <div class="movie-grid">
        <article
          v-for="(movie, index) in movies"
          :key="movie.tmdbId"
          class="movie-card clickable"
          tabindex="0"
          :aria-label="t('a11y.viewMovieDetails', { title: movie.title })"
          @click="emit('openMovie', movie.tmdbId)"
          @keydown.enter.self="emit('openMovie', movie.tmdbId)"
          @keydown.space.self.prevent="emit('openMovie', movie.tmdbId)"
        >
          <div class="poster-frame">
            <img
              v-if="movie.posterUrl && !failedPosters.has(movie.tmdbId)"
              :src="movie.posterUrl"
              :alt="t('a11y.moviePoster', { title: movie.title })"
              loading="lazy"
              @error="markPosterFailed(movie.tmdbId)"
            />
            <div v-else class="poster-placeholder" role="img" :aria-label="t('a11y.moviePosterUnavailable', { title: movie.title })"><span aria-hidden="true">{{ t('movie.posterUnavailable') }}</span></div>
            <span v-if="!searching" class="rank">{{ String(index + 1).padStart(2, '0') }}</span>
            <div class="preference-control" role="group" :aria-label="t('a11y.moviePreference', { title: movie.title })">
              <button
                type="button"
                class="preference-button"
                :class="{ active: movie.userPreference === 'liked' }"
                :aria-label="t(movie.userPreference === 'liked' ? 'movie.preference.clearLiked' : 'movie.preference.like')"
                :aria-pressed="movie.userPreference === 'liked'"
                :disabled="updating.has(movie.tmdbId)"
                @click.stop="setPreference(movie, 'liked')"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 20.5 3.8 12.9A5.4 5.4 0 0 1 11.4 5l.6.7.6-.7a5.4 5.4 0 0 1 7.6 7.9L12 20.5Z" /></svg>
              </button>
              <button
                type="button"
                class="preference-button dislike"
                :class="{ active: movie.userPreference === 'disliked' }"
                :aria-label="t(movie.userPreference === 'disliked' ? 'movie.preference.clearDisliked' : 'movie.preference.dislike')"
                :aria-pressed="movie.userPreference === 'disliked'"
                :disabled="updating.has(movie.tmdbId)"
                @click.stop="setPreference(movie, 'disliked')"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7.2 3h8.9a2 2 0 0 1 1.9 1.4l1.7 5.1a3 3 0 0 1-2.8 4h-3l.5 3.7a2.4 2.4 0 0 1-4.4 1.5L6.7 13H4a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2.2L7.2 3Zm0 2.5v5.2l4.5 7.1-.7-5.3a1.3 1.3 0 0 1 1.3-1.5h4.6a.5.5 0 0 0 .5-.7l-1.6-4.8H7.2Z" /></svg>
              </button>
            </div>
            <div class="poster-interface" aria-hidden="true">
              <span class="interface-code">MH / {{ movie.tmdbId }}</span>
              <div class="interface-meta">
                <span>{{ releaseDateLabel(movie.releaseDate) }}</span
                ><span v-if="movie.voteAverage !== undefined" :aria-label="t('movie.rating', { rating: ratingLabel(movie.voteAverage) })"><span aria-hidden="true">★ {{ ratingLabel(movie.voteAverage) }}</span></span>
              </div>
              <span class="interface-action">{{ t('movie.openDetails') }} <b>↗</b></span>
            </div>
          </div>
          <div class="movie-copy">
            <h3>{{ movie.title }}</h3>
            <p class="original-title" :class="{ placeholder: !movie.originalTitle || movie.originalTitle === movie.title }" :aria-hidden="!movie.originalTitle || movie.originalTitle === movie.title">
              {{ movie.originalTitle && movie.originalTitle !== movie.title ? movie.originalTitle : '\u00a0' }}
            </p>
            <div class="movie-meta">
              <span>{{ releaseDateLabel(movie.releaseDate) }}</span
              ><span v-if="movie.voteAverage !== undefined" class="rating" :aria-label="t('movie.rating', { rating: ratingLabel(movie.voteAverage) })"><span aria-hidden="true">★ {{ ratingLabel(movie.voteAverage) }}</span></span
              ><span v-else class="rating rating-missing" :aria-label="t('movie.ratingUnavailable')">—</span>
            </div>
            <div class="status-control" :aria-label="t('a11y.movieStatus', { title: movie.title })">
              <button
                v-for="option in statusOptions"
                :key="option[0]"
                type="button"
                :class="{ active: movie.userStatus === option[0] }"
                :aria-pressed="movie.userStatus === option[0]"
                :disabled="updating.has(movie.tmdbId)"
                @click.stop="setStatus(movie, option[0])"
              >
                {{ option[1] }}
              </button>
            </div>
          </div>
        </article>
      </div>
      <div class="load-more-wrap">
        <button v-if="hasMore" class="outline-button load-more" type="button" :disabled="!canLoadMore" :aria-busy="loadingMore" @click="loadMore">{{ t(loadingMore ? 'actions.loadingMore' : 'actions.loadMore') }}</button>
        <p v-else class="end-note">{{ t('status.allResultsLoaded') }}</p>
      </div>
    </template>
  </section>
</template>
