<script setup lang="ts">
import type { WatchlistItem, MyMoviesResponse } from '@movie-hub/contract';
import { onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { useI18n } from '../../i18n';
import { localizedErrorMessage } from '../../i18n/api-error';
import MediaList from '../media/MediaList.vue';
import { loadWebConfig } from '../../config/env';
import { localizedResponseError } from '../../i18n/api-error';
import type { ViewingPreferenceFilter } from './viewing-preferences.types';

const emit = defineEmits<{ openMovie: [tmdbId: number] }>();
const { apiBaseUrl } = loadWebConfig();
const filters = ['watched', 'liked', 'disliked'] as const;
async function requestMovies(filter: ViewingPreferenceFilter, number: number, pageSize: number, signal: AbortSignal): Promise<MyMoviesResponse> {
  const response = await fetch(`${apiBaseUrl}/me/movies?status=${filter}&page=${number}&pageSize=${pageSize}&locale=${locale.value}`, { signal, credentials: 'include' });
  if (!response.ok) throw await localizedResponseError(response, 'viewingPreferences.error');
  return response.json() as Promise<MyMoviesResponse>;
}
const { t, locale, formatNumber } = useI18n();
const filter = ref<ViewingPreferenceFilter>('watched');
const items = ref<WatchlistItem[]>([]);
const page = ref(0);
const totals = ref<Partial<Record<ViewingPreferenceFilter, number>>>({});
const hasMore = ref(false);
const loading = ref(false);
const error = ref('');
const failedAppend = ref(false);
let controller: AbortController | undefined;
let generation = 0;
let active = true;

async function load(append = false) {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  const version = ++generation;
  const nextPage = append ? page.value + 1 : Math.max(1, page.value);
  failedAppend.value = append;
  loading.value = true;
  error.value = '';
  try {
    const pages = append ? [nextPage] : Array.from({ length: nextPage }, (_, index) => index + 1);
    const selectedPages = Promise.all(pages.map((number) => requestMovies(filter.value, number, 20, request.signal)));
    if (!append) {
      for (const other of filters.filter((value) => value !== filter.value)) {
        void requestMovies(other, 1, 1, request.signal).then((result) => {
          if (!request.signal.aborted && version === generation) totals.value[other] = result.pagination.total;
        }).catch(() => { /* The category request provides its own error and retry when selected. */ });
      }
    }
    const results = await selectedPages;
    const result = results[results.length - 1]!;
    if (request.signal.aborted || version !== generation) return;
    const existing = new Set(append ? items.value.map((item) => `${item.mediaType}:${item.tmdbId}`) : []);
    const incoming = results.flatMap((result) => result.items.map((item) => ({ ...item, mediaType: 'movie' as const }))).filter((item) => {
      const key = `${item.mediaType}:${item.tmdbId}`;
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });
    items.value = append ? [...items.value, ...incoming] : incoming;
    page.value = result.pagination.page;
    totals.value[filter.value] = result.pagination.total;
    hasMore.value = result.pagination.hasMore;
  } catch (cause) {
    if (!request.signal.aborted && version === generation) error.value = localizedErrorMessage(cause, 'viewingPreferences.error');
  } finally {
    if (version === generation) loading.value = false;
  }
}
function reset() {
  items.value = [];
  page.value = 0;
  delete totals.value[filter.value];
  hasMore.value = false;
  if (active) void load();
}
function stop() {
  controller?.abort();
  ++generation;
  loading.value = false;
}
function open(item: WatchlistItem) {
  emit('openMovie', item.tmdbId);
}
watch([filter, locale], reset);
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
    <div class="watchlist-filters" role="group" :aria-label="t('viewingPreferences.title')">
      <button v-for="category in filters" :key="category" type="button" :class="{ active: filter === category }" :aria-pressed="filter === category" @click="filter = category">
        {{ t(category === 'watched' ? 'movie.status.watched' : category === 'liked' ? 'movie.preference.liked' : 'movie.preference.disliked') }}
        <span v-if="totals[category] !== undefined" class="watchlist-count">{{ formatNumber(totals[category]!) }}</span>
      </button>
    </div>
    <div v-if="error" class="movie-state" role="alert"><p>{{ error }}</p><button class="outline-button" type="button" @click="load(failedAppend)">{{ t('actions.retry') }}</button></div>
    <p v-if="loading && !items.length" class="movie-state" role="status">{{ t('viewingPreferences.loading') }}</p>
    <p v-else-if="!loading && !error && !items.length" class="movie-state">{{ t('viewingPreferences.empty') }}</p>
    <MediaList :items="items" @open="open" />
    <div v-if="hasMore" class="tv-load-more"><button type="button" class="outline-button" :disabled="loading" @click="load(true)">{{ t(loading ? 'viewingPreferences.loading' : 'watchlist.loadMore') }}</button></div>
  </section>
</template>
