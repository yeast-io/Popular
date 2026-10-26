<script setup lang="ts">
import type { WatchlistItem, WatchlistMediaType, WatchlistResponse } from '@movie-hub/contract';
import { onActivated, onBeforeUnmount, onDeactivated, nextTick, ref, watch } from 'vue';
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
const savingKey = ref('');
const actionError = ref('');
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
  actionError.value = '';
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
async function removeItem(item: WatchlistItem) {
  if (loading.value || savingKey.value) return;
  const key = `${item.mediaType}:${item.tmdbId}`;
  const version = generation;
  savingKey.value = key;
  actionError.value = '';
  try {
    const path = `/${item.mediaType}/${item.tmdbId}`;
    await watchlistRequest(path, { method: 'DELETE' });
    if (!active) return;
    if (version !== generation) {
      await load();
      return;
    }
    items.value = items.value.filter((entry) => entry !== item);
    totals.value[item.mediaType] = Math.max(0, (totals.value[item.mediaType] ?? 1) - 1);
    page.value = Math.max(1, Math.min(page.value, Math.ceil(totals.value[item.mediaType]! / 20)));
    await nextTick();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
    if (active && version === generation) await load();
  } catch (cause) {
    if (active && version === generation) actionError.value = localizedErrorMessage(cause, 'watchlist.updateError');
  } finally {
    savingKey.value = '';
  }
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
    <p v-else-if="!loading && !savingKey && !error && !items.length" class="movie-state">{{ t(mediaType === 'movie' ? 'watchlist.emptyMovies' : 'watchlist.emptyTv') }}</p>
    <p v-if="actionError" class="browse-error" role="alert">{{ actionError }}</p>
    <MediaList :key="`${mediaType}:${locale}`" :items="items" animate-removal @open="open">
      <template #actions="{ item }">
        <div class="watchlist-actions" :aria-busy="savingKey === `${item.mediaType}:${item.tmdbId}`">
          <button class="watchlist-remove" type="button" :disabled="loading || !!savingKey"
            :aria-label="t('watchlist.removeTitle', { title: item.title })" :title="t('watchlist.remove')" @click="removeItem(item)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6" /></svg>
          </button>
        </div>
      </template>
    </MediaList>
    <div v-if="hasMore" class="tv-load-more"><button type="button" class="outline-button" :disabled="loading" @click="load(true)">{{ t(loading ? 'watchlist.loading' : 'watchlist.loadMore') }}</button></div>
  </section>
</template>

<style scoped>
.watchlist-page :deep(.watchlist-row) { position: relative; overflow: hidden; border: 1px solid #35383b; border-radius: 8px; background: rgba(19, 21, 23, .8); }
.watchlist-page :deep(.watchlist-row:hover) { border-color: #786057; background: rgba(27, 28, 30, .95); }
.watchlist-page :deep(.watchlist-row > .watchlist-entry) { border: 0; border-radius: 0; background: transparent; }
.watchlist-page :deep(.watchlist-row > .watchlist-entry:focus-visible) { outline-offset: -3px; }
.watchlist-page :deep(.watchlist-copy) { padding-right: 64px; }
.watchlist-page :deep(.watchlist-remove-leave-active) { box-sizing: border-box; height: var(--watchlist-row-height); min-height: 0; pointer-events: none; transition: opacity 150ms ease, transform 150ms ease, height 150ms ease 150ms, margin-bottom 150ms ease 150ms, border-width 150ms ease 150ms; }
.watchlist-page :deep(.watchlist-remove-leave-from) { opacity: 1; transform: scale(1); margin-bottom: 0; }
.watchlist-page :deep(.watchlist-remove-leave-to) { opacity: 0; transform: scale(.98); height: 0; margin-bottom: -18px; border-top-width: 0; border-bottom-width: 0; }
.watchlist-actions { position: absolute; top: 16px; right: 16px; }
.watchlist-remove { display: grid; place-items: center; width: 32px; height: 32px; min-height: 0; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #858a91; cursor: pointer; }
.watchlist-remove svg { width: 17px; height: 17px; }
.watchlist-remove:hover:not(:disabled) { border-color: #bd665c40; background: #bd665c1a; color: #df8b80; }
.watchlist-remove:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.watchlist-remove:disabled { opacity: .4; cursor: not-allowed; }
@media (max-width: 560px) {
  .watchlist-actions { top: 8px; right: 8px; }
  .watchlist-page :deep(.watchlist-copy) { padding-right: 48px; }
}
</style>
