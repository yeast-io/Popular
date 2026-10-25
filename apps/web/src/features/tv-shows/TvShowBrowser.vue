<script setup lang="ts">
import type { TvShowSummary, TvTrendingResponse, TvSearchResponse, TrackedMoviePreference, MoviePreference } from '@movie-hub/contract';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from '../../i18n';
import { loadWebConfig } from '../../config/env';
import { localizedResponseError } from '../../i18n/api-error';
import { LocalizedApiError, localizedErrorMessage } from '../../i18n/api-error';
import { tvRequest } from './tv-show.client';
import TvShowCard from './TvShowCard.vue';
import MediaSearchBox from '../media/MediaSearchBox.vue';

const props = defineProps<{ authenticated?: boolean }>();
const emit = defineEmits<{
  requireLogin: [];
  openTvShow: [
        tmdbId: number,
  ];
}>();
const { locale, t } = useI18n();
const { apiBaseUrl } = loadWebConfig();
const updating = ref(new Set<number>());
const preferenceError = ref('');
const preferenceRequests = new Set<AbortController>();
const localPreferences = new Map<number, MoviePreference>();
const shows = ref<TvShowSummary[]>([]);
const query = ref('');
const searching = computed(() => query.value.trim().length > 0);
const loading = ref(false);
const error = ref('');
const page = ref(0);
const hasMore = ref(false);
const generation = ref('');
const stale = ref(false);
let controller: AbortController | undefined;
let requestId = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
async function load(reset = false) {
  const id = ++requestId;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  if (reset) {
    shows.value = [];
    page.value = 0;
    hasMore.value = false;
    generation.value = '';
    stale.value = false;
  }
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({ locale: locale.value, page: String(page.value + 1) });
    const term = query.value.trim();
    let response: TvTrendingResponse | TvSearchResponse;
    if (term) {
      params.set('query', term);
      response = await tvRequest<TvSearchResponse>(`/search?${params}`, current.signal);
    } else {
      if (generation.value) params.set('generation', generation.value);
      response = await tvRequest<TvTrendingResponse>(`/trending?${params}`, current.signal);
    }
    if (id !== requestId || current.signal.aborted)
      return;
    const seen = new Set(shows.value.map((show) => show.tmdbId));
    shows.value.push(...response.items.filter((show) => !seen.has(show.tmdbId)).map((show) => ({ ...show, userPreference: localPreferences.get(show.tmdbId) ?? show.userPreference ?? 'neutral' })));
    page.value = response.page;
    generation.value = 'generation' in response ? response.generation : '';
    hasMore.value = response.hasMore;
    stale.value = response.stale;
  } catch (cause) {
    if (id === requestId && !current.signal.aborted) {
      if (cause instanceof LocalizedApiError && cause.translationKey === 'errors.mediaTrendingExpired') {
        shows.value = [];
        page.value = 0;
        generation.value = '';
        hasMore.value = false;
      }
      error.value = localizedErrorMessage(cause, 'tv.error.load');
    }
  } finally {
    if (id === requestId)
      loading.value = false;
  }
}
async function setPreference(show: TvShowSummary, preference: TrackedMoviePreference) {
  if (!props.authenticated) {
    emit('requireLogin');
    return;
  }
  if (updating.value.has(show.tmdbId)) return;
  const previous = show.userPreference ?? 'neutral';
  const next: MoviePreference = previous === preference ? 'neutral' : preference;
  const request = new AbortController();
  preferenceRequests.add(request);
  show.userPreference = next;
  localPreferences.set(show.tmdbId, next);
  updating.value = new Set(updating.value).add(show.tmdbId);
  preferenceError.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/tv-shows/${show.tmdbId}/preference?locale=${locale.value}`, {
      method: next === 'neutral' ? 'DELETE' : 'PUT', credentials: 'include', signal: request.signal,
      ...(next === 'neutral' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preference: next }) }),
    });
    if (!response.ok) {
      if (response.status === 401) emit('requireLogin');
      throw await localizedResponseError(response, 'tv.error.preference');
    }
  } catch (cause) {
    if (!request.signal.aborted) {
      show.userPreference = previous;
      localPreferences.set(show.tmdbId, previous);
      const current = shows.value.find((item) => item.tmdbId === show.tmdbId);
      if (current) current.userPreference = previous;
      preferenceError.value = localizedErrorMessage(cause, 'tv.error.preference');
    }
  } finally {
    preferenceRequests.delete(request);
    const pending = new Set(updating.value);
    pending.delete(show.tmdbId);
    updating.value = pending;
  }
}
function restart(debounce: boolean) {
  ++requestId;
  controller?.abort();
  if (debounceTimer) clearTimeout(debounceTimer);
  shows.value = [];
  page.value = 0;
  hasMore.value = false;
  generation.value = '';
  stale.value = false;
  error.value = '';
  loading.value = true;
  if (debounce) debounceTimer = setTimeout(() => void load(true), 300);
  else void load(true);
}
watch(query, () => restart(true), { flush: 'sync' });
watch(locale, () => restart(false), { immediate: true, flush: 'sync' });
onBeforeUnmount(() => {
  ++requestId;
  controller?.abort();
  for (const request of preferenceRequests) request.abort();
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<template>
  <section class="movie-section tv-section media-browser" :aria-label="t('nav.tvShows')" :aria-busy="loading">
    <MediaSearchBox v-model="query" :label="t('tv.searchLabel')" :placeholder="t('tv.searchPlaceholder')" />
    <p v-if="preferenceError" class="browse-error" role="alert">{{ preferenceError }}</p>
    <p v-if="stale" class="freshness" role="status">{{ t('tv.stale') }}</p>
    <div v-if="error" class="movie-state" role="alert">
      <p>{{ error }}</p><button class="outline-button" type="button" @click="load(page === 0)">{{ t('actions.retry') }}</button>
    </div>
    <div v-if="shows.length" class="movie-grid">
      <TvShowCard v-for="show in shows" :key="show.tmdbId" :show="show" :authenticated="authenticated" :updating="updating.has(show.tmdbId)" @preference="setPreference(show, $event)" @open="emit('openTvShow', $event)" />
    </div>
    <p v-if="loading" class="movie-state" role="status">{{ t(searching ? 'tv.searching' : 'tv.loading') }}</p>
    <p v-else-if="!error && !shows.length" class="movie-state">{{ t(searching ? 'tv.searchEmpty' : 'tv.empty') }}</p>
    <div v-if="hasMore" class="tv-load-more"><button class="outline-button" type="button" :disabled="loading" @click="load()">{{ t('tv.loadMore') }}</button></div>
  </section>
</template>
