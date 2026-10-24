<script setup lang="ts">
import type { WatchlistItem, WatchlistMediaType, WatchlistResponse } from '@movie-hub/contract';
import { onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { useI18n } from '../../i18n';
import { localizedErrorMessage } from '../../i18n/api-error';
import MediaList from '../media/MediaList.vue';
import { watchlistRequest } from './watchlist.client';

const emit = defineEmits<{ openMovie: [tmdbId: number]; openTvShow: [tmdbId: number] }>();
const { t, locale, formatNumber } = useI18n();
const mediaType = ref<WatchlistMediaType>('movie');
const items = ref<WatchlistItem[]>([]);
const page = ref(0);
const totals = ref<Partial<Record<WatchlistMediaType, number>>>({});
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
    const otherType = mediaType.value === 'movie' ? 'tv' : 'movie';
    const selectedPages = Promise.all(pages.map((number) => watchlistRequest<WatchlistResponse>(`?mediaType=${mediaType.value}&page=${number}&pageSize=20&locale=${locale.value}`, { signal: request.signal })));
    if (!append) {
      void watchlistRequest<WatchlistResponse>(`?mediaType=${otherType}&page=1&pageSize=1&locale=${locale.value}`, { signal: request.signal }).then((result) => {
        if (!request.signal.aborted && version === generation) totals.value[otherType] = result.pagination.total;
      }).catch(() => { /* Keep an unavailable category count hidden; opening that category provides retry. */ });
    }
    const results = await selectedPages;
    const result = results[results.length - 1]!;
    if (request.signal.aborted || version !== generation) return;
    const existing = new Set(append ? items.value.map((item) => `${item.mediaType}:${item.tmdbId}`) : []);
    const incoming = results.flatMap((result) => result.items).filter((item) => {
      const key = `${item.mediaType}:${item.tmdbId}`;
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });
    items.value = append ? [...items.value, ...incoming] : incoming;
    page.value = result.pagination.page;
    totals.value[mediaType.value] = result.pagination.total;
    hasMore.value = result.pagination.hasMore;
  } catch (cause) {
    if (!request.signal.aborted && version === generation) error.value = localizedErrorMessage(cause, 'watchlist.error');
  } finally {
    if (version === generation) loading.value = false;
  }
}
function reset() {
  items.value = [];
  page.value = 0;
  delete totals.value[mediaType.value];
  hasMore.value = false;
  if (active) void load();
}
function stop() {
  controller?.abort();
  ++generation;
  loading.value = false;
}
function open(item: WatchlistItem) {
  if (item.mediaType === 'movie') emit('openMovie', item.tmdbId);
  else emit('openTvShow', item.tmdbId);
}
watch([mediaType, locale], reset);
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
  <section class="movie-section watchlist-page" :aria-label="t('watchlist.title')">
    <div class="watchlist-filters" role="group" :aria-label="t('watchlist.category')">
      <button v-for="category in (['movie', 'tv'] as const)" :key="category" type="button" :class="{ active: mediaType === category }" :aria-pressed="mediaType === category" @click="mediaType = category">
        {{ t(category === 'movie' ? 'nav.movies' : 'nav.tvShows') }}
        <span v-if="totals[category] !== undefined" class="watchlist-count">{{ formatNumber(totals[category]!) }}</span>
      </button>
    </div>
    <div v-if="error" class="movie-state" role="alert"><p>{{ error }}</p><button class="outline-button" type="button" @click="load(failedAppend)">{{ t('actions.retry') }}</button></div>
    <p v-if="loading && !items.length" class="movie-state" role="status">{{ t('watchlist.loading') }}</p>
    <p v-else-if="!loading && !error && !items.length" class="movie-state">{{ t(mediaType === 'movie' ? 'watchlist.emptyMovies' : 'watchlist.emptyTv') }}</p>
    <MediaList :items="items" @open="open" />
    <div v-if="hasMore" class="tv-load-more"><button type="button" class="outline-button" :disabled="loading" @click="load(true)">{{ t(loading ? 'watchlist.loading' : 'watchlist.loadMore') }}</button></div>
  </section>
</template>
