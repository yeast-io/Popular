<script setup lang="ts">
import type { WatchlistItem, WatchlistMediaType, WatchlistResponse, TrackedMoviePreference } from '@movie-hub/contract';
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { useI18n } from '../../i18n';
import { localizedErrorMessage } from '../../i18n/api-error';
import MediaList from '../media/MediaList.vue';
import { loadWebConfig } from '../../config/env';
import { localizedResponseError } from '../../i18n/api-error';
import type { ViewingPreferenceFilter } from './viewing-preferences.types';

const emit = defineEmits<{ openMovie: [tmdbId: number]; openTvShow: [tmdbId: number] }>();
const { apiBaseUrl } = loadWebConfig();
const mediaType = ref<WatchlistMediaType>('movie');
const filters = computed<readonly ViewingPreferenceFilter[]>(() => mediaType.value === 'movie' ? ['watched', 'liked', 'disliked'] : ['liked', 'disliked']);
async function requestPreferences(media: WatchlistMediaType, selected: ViewingPreferenceFilter, number: number, pageSize: number, signal: AbortSignal): Promise<WatchlistResponse> {
  const path = media === 'movie' ? `/me/movies?status=${selected}` : `/me/tv-shows/preferences?preference=${selected}`;
  const response = await fetch(`${apiBaseUrl}${path}&page=${number}&pageSize=${pageSize}&locale=${locale.value}`, { signal, credentials: 'include' });
  if (!response.ok) throw await localizedResponseError(response, 'viewingPreferences.error');
  return response.json() as Promise<WatchlistResponse>;
}
const { t, locale, formatNumber } = useI18n();
const movieFilter = ref<ViewingPreferenceFilter>('watched');
const tvFilter = ref<TrackedMoviePreference>('liked');
const filter = computed(() => mediaType.value === 'movie' ? movieFilter.value : tvFilter.value);
function selectFilter(selected: ViewingPreferenceFilter) {
  if (mediaType.value === 'movie') movieFilter.value = selected;
  else if (selected !== 'watched') tvFilter.value = selected;
}
function selectMedia(selected: WatchlistMediaType) {
  if (selected === mediaType.value) return;
  if (selected === 'tv') tvFilter.value = movieFilter.value === 'watched' ? 'liked' : movieFilter.value;
  mediaType.value = selected;
}
const items = ref<WatchlistItem[]>([]);
const page = ref(0);
const mediaTotals = ref<Record<WatchlistMediaType, Partial<Record<ViewingPreferenceFilter, number>>>>({ movie: {}, tv: {} });
const totals = computed(() => mediaTotals.value[mediaType.value]);
const hasMore = ref(false);
const loading = ref(false);
const error = ref('');
const failedAppend = ref(false);
const resultsContainer = ref<HTMLElement | null>(null);
const resultsHeight = ref(0);
const resultVersion = ref(0);
function lockResultsHeight() {
  const height = resultsContainer.value?.getBoundingClientRect().height ?? 0;
  if (height > 0) resultsHeight.value = height;
}
function resizeResults(element: Element) {
  if (element instanceof HTMLElement) resultsHeight.value = element.getBoundingClientRect().height;
}
function releaseResultsHeight() {
  if (!loading.value) resultsHeight.value = 0;
}
let controller: AbortController | undefined;
let generation = 0;
let active = true;

async function load(append = false) {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const version = ++generation;
  const selectedMedia = mediaType.value;
  const selectedFilter = filter.value;
  const nextPage = append ? page.value + 1 : Math.max(1, page.value);
  failedAppend.value = append;
  loading.value = true;
  error.value = '';
  try {
    const pages = append ? [nextPage] : Array.from({ length: nextPage }, (_, index) => index + 1);
    const selectedPages = Promise.all(pages.map((number) => requestPreferences(selectedMedia, selectedFilter, number, 20, request.signal)));
    if (!append) {
      for (const other of filters.value.filter((value) => value !== selectedFilter)) {
        void requestPreferences(selectedMedia, other, 1, 1, request.signal).then((result) => {
          if (!request.signal.aborted && version === generation) mediaTotals.value[selectedMedia][other] = result.pagination.total;
        }).catch(() => { /* The category request provides its own error and retry when selected. */ });
      }
    }
    const results = await selectedPages;
    const result = results[results.length - 1]!;
    if (request.signal.aborted || version !== generation) return;
    const existing = new Set(append ? items.value.map((item) => `${item.mediaType}:${item.tmdbId}`) : []);
    const incoming = results.flatMap((result) => result.items.map((item) => ({ ...item, mediaType: selectedMedia }))).filter((item) => {
      const key = `${item.mediaType}:${item.tmdbId}`;
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });
    items.value = append ? [...items.value, ...incoming] : incoming;
    page.value = result.pagination.page;
    totals.value[filter.value] = result.pagination.total;
    hasMore.value = result.pagination.hasMore;
    if (!append) resultVersion.value++;
  } catch (cause) {
    if (!request.signal.aborted && version === generation) {
      error.value = localizedErrorMessage(cause, 'viewingPreferences.error');
      if (!append) {
        items.value = [];
        hasMore.value = false;
        resultVersion.value++;
      }
    }
  } finally {
    if (version === generation) loading.value = false;
  }
}
function reset() {
  lockResultsHeight();
  page.value = 0;
  hasMore.value = false;
  if (active) void load();
}
function stop() {
  controller?.abort();
  ++generation;
  loading.value = false;
  releaseResultsHeight();
}
function open(item: WatchlistItem) {
  if (loading.value && !failedAppend.value) return;
  if (item.mediaType === 'movie') emit('openMovie', item.tmdbId);
  else emit('openTvShow', item.tmdbId);
}
watch([mediaType, filter, locale], reset);
onActivated(() => {
  active = true;
  void load();
});
onDeactivated(() => {
  active = false;
  stop();
});
onBeforeUnmount(stop);
</script>

<template>
  <section class="movie-section viewing-preferences-page" :aria-label="t('viewingPreferences.title')">
    <div class="viewing-preferences-media" role="group" :aria-label="t('watchlist.category')">
      <button v-for="category in (['movie', 'tv'] as const)" :key="category" type="button" :class="{ active: mediaType === category }" :aria-pressed="mediaType === category" @click="selectMedia(category)">
        {{ t(category === 'movie' ? 'nav.movies' : 'nav.tvShows') }}
      </button>
    </div>
    <div class="watchlist-filters viewing-preferences-filters" role="group" :aria-label="t('viewingPreferences.filter')">
      <button v-for="category in filters" :key="category" type="button" :class="{ active: filter === category }" :aria-pressed="filter === category" @click="selectFilter(category)">
        {{ t(category === 'watched' ? 'movie.status.watched' : category === 'liked' ? 'movie.preference.liked' : 'movie.preference.disliked') }}
        <span class="watchlist-count" :aria-hidden="totals[category] === undefined">{{ totals[category] === undefined ? '' : formatNumber(totals[category]!) }}</span>
      </button>
    </div>
    <div ref="resultsContainer" class="viewing-preferences-results" :class="{ 'is-resizing': resultsHeight > 0 }"
      :style="resultsHeight > 0 ? { height: `${resultsHeight}px` } : undefined" :aria-busy="loading">
      <Transition name="preference-results" mode="out-in" @before-leave="lockResultsHeight" @enter="resizeResults" @after-enter="releaseResultsHeight" @enter-cancelled="releaseResultsHeight">
        <div :key="resultVersion" class="viewing-preferences-content" :class="{ 'is-loading': loading && !failedAppend }" :inert="loading && !failedAppend">
          <div v-if="error" class="movie-state" role="alert"><p>{{ error }}</p><button class="outline-button" type="button" @click="load(failedAppend)">{{ t('actions.retry') }}</button></div>
          <p v-if="loading && !items.length" class="movie-state" role="status">{{ t('viewingPreferences.loading') }}</p>
          <p v-else-if="!loading && !error && !items.length" class="movie-state">{{ t(mediaType === 'movie' ? 'viewingPreferences.empty' : 'viewingPreferences.emptyTv') }}</p>
          <MediaList :items="items" @open="open" />
          <div v-if="hasMore" class="tv-load-more"><button type="button" class="outline-button" :disabled="loading" @click="load(true)">{{ t(loading ? 'viewingPreferences.loading' : 'watchlist.loadMore') }}</button></div>
        </div>
      </Transition>
      <p v-if="loading && items.length && !failedAppend" class="viewing-preferences-loading" role="status">{{ t('viewingPreferences.loading') }}</p>
    </div>
  </section>
</template>
