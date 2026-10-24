<script setup lang="ts">
import type { TvEpisode, TvShowDetail, TvSeasonDetail, WatchlistMembership } from '@movie-hub/contract';
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useI18n } from '../../i18n';
import { localizedErrorMessage } from '../../i18n/api-error';
import { tvRequest } from './tv-show.client';
import MediaTrailerDialog from '../media/MediaTrailerDialog.vue';
import TvSeasonSelector from './TvSeasonSelector.vue';
import TvEpisodeList from './TvEpisodeList.vue';
import TvEpisodeDetailDialog from './TvEpisodeDetailDialog.vue';
import { watchlistRequest } from '../watchlist/watchlist.client';
import { tvStatusLabel } from './tv-show.presentation';

const props = defineProps<{
  tmdbId: number;
  authenticated?: boolean;
  backLabel?: string;
}>();
const emit = defineEmits<{
  requireLogin: [];
  back: [
  ];
}>();
const { t, locale, formatNumber, formatDate } = useI18n();
const show = ref<TvShowDetail | null>(null);
const trailerOpen = ref(false);
const season = ref<TvSeasonDetail | null>(null);
const selectedSeason = ref<number | null>(null);
const selectedEpisode = ref<TvEpisode | null>(null);
const loading = ref(false);
const inWatchlist = ref(false);
const watchlistTooltipId = useId();
const membershipLoading = ref(false);
const savingWatchlist = ref(false);
const watchlistError = ref('');
const seasonLoading = ref(false);
const error = ref('');
const seasonError = ref('');
const posterFailed = ref(false);
const statusLabel = computed(() => tvStatusLabel(show.value?.status));
let detailController: AbortController | undefined;
let seasonController: AbortController | undefined;
let detailGeneration = 0;
let seasonGeneration = 0;
async function loadDetail() {
  const id = ++detailGeneration;
  detailController?.abort();
  seasonController?.abort();
  ++seasonGeneration;
  const current = new AbortController();
  detailController = current;
  trailerOpen.value = false;
  show.value = null;
  season.value = null;
  selectedSeason.value = null;
  selectedEpisode.value = null;
  error.value = '';
  seasonError.value = '';
  posterFailed.value = false;
  loading.value = true;
  inWatchlist.value = false;
  watchlistError.value = '';
  savingWatchlist.value = false;
  membershipLoading.value = false;
  try {
    const response = await tvRequest<TvShowDetail>(`/${props.tmdbId}?locale=${locale.value}`, current.signal);
    if (id !== detailGeneration || current.signal.aborted)
      return;
    show.value = response;
    if (props.authenticated) void loadMembership(id, current.signal);
    const regular = response.seasons.filter((s) => s.seasonNumber > 0).sort((a, b) => a.seasonNumber - b.seasonNumber);
    selectedSeason.value = regular.find((s) => s.seasonNumber === 1)?.seasonNumber ?? regular[0]?.seasonNumber ?? response.seasons[0]?.seasonNumber ?? null;
  } catch (cause) {
    if (id === detailGeneration && !current.signal.aborted)
      error.value = localizedErrorMessage(cause, 'tv.error.load');
  } finally {
    if (id === detailGeneration)
      loading.value = false;
  }
}
async function loadMembership(version: number, signal: AbortSignal) {
  membershipLoading.value = true;
  try {
    const result = await watchlistRequest<WatchlistMembership>(`/tv-shows/${props.tmdbId}`, { signal });
    if (version === detailGeneration && !signal.aborted) inWatchlist.value = result.inWatchlist;
  } catch (cause) {
    if (version === detailGeneration && !signal.aborted) watchlistError.value = localizedErrorMessage(cause, 'watchlist.error');
  } finally {
    if (version === detailGeneration) membershipLoading.value = false;
  }
}
async function toggleWatchlist() {
  if (!props.authenticated) {
    emit('requireLogin');
    return;
  }
  if (savingWatchlist.value || membershipLoading.value) return;
  const version = detailGeneration;
  const signal = detailController?.signal;
  if (watchlistError.value) {
    if (signal) {
      watchlistError.value = '';
      await loadMembership(version, signal);
    }
    return;
  }
  savingWatchlist.value = true;
  watchlistError.value = '';
  try {
    const result = await watchlistRequest<WatchlistMembership>(`/tv-shows/${props.tmdbId}?locale=${locale.value}`, { method: inWatchlist.value ? 'DELETE' : 'PUT', ...(signal ? { signal } : {}) });
    if (version === detailGeneration && !signal?.aborted) inWatchlist.value = result.inWatchlist;
  } catch (cause) {
    if (version === detailGeneration && !signal?.aborted) watchlistError.value = localizedErrorMessage(cause, 'watchlist.updateError');
  } finally {
    if (version === detailGeneration) savingWatchlist.value = false;
  }
}
async function loadSeason() {
  const id = ++seasonGeneration;
  seasonController?.abort();
  selectedEpisode.value = null;
  season.value = null;
  seasonError.value = '';
  if (selectedSeason.value === null) {
    seasonLoading.value = false;
    return;
  }
  const current = new AbortController();
  seasonController = current;
  seasonLoading.value = true;
  try {
    const response = await tvRequest<TvSeasonDetail>(`/${props.tmdbId}/seasons/${selectedSeason.value}?locale=${locale.value}`, current.signal);
    if (id !== seasonGeneration || current.signal.aborted)
      return;
    season.value = response;
  } catch (cause) {
    if (id === seasonGeneration && !current.signal.aborted)
      seasonError.value = localizedErrorMessage(cause, 'tv.error.season');
  } finally {
    if (id === seasonGeneration)
      seasonLoading.value = false;
  }
}
watch(selectedSeason, () => void loadSeason(), { flush: 'sync' });
watch([() => props.tmdbId, () => props.authenticated, locale], () => void loadDetail(), { immediate: true, flush: 'sync' });
onBeforeUnmount(() => {
  ++detailGeneration;
  ++seasonGeneration;
  detailController?.abort();
  seasonController?.abort();
});
</script>

<template>
  <section class="detail-page tv-detail">
    <button class="back-button detail-back" type="button" @click="emit('back')">{{ backLabel || t('actions.backTvShows') }}</button>
    <p v-if="loading" class="movie-state" role="status">{{ t('tv.loading') }}</p>
    <div v-else-if="error" class="movie-state" role="alert"><p>{{ error }}</p><button class="outline-button" type="button" @click="loadDetail">{{ t('actions.retry') }}</button></div>
    <article v-else-if="show" class="detail-content">
      <div v-if="show.backdropUrl" class="detail-backdrop" :style="{ backgroundImage: `linear-gradient(90deg, #0b0c0d 0%, rgba(11,12,13,.45) 55%, #0b0c0d 100%), url(${show.backdropUrl})` }"></div>
      <div class="detail-hero">
        <div class="detail-poster">
          <img v-if="show.posterUrl && !posterFailed" :src="show.posterUrl" :alt="show.name" @error="posterFailed = true" />
          <div v-else class="poster-placeholder">{{ t('tv.imageUnavailable') }}</div>
        </div>
        <div class="detail-copy">
          <p class="eyebrow">{{ t('tv.module') }}</p><h1>{{ show.name || show.originalName || t('tv.unnamed') }}</h1>
          <p v-if="show.originalName && show.originalName !== show.name" class="detail-original">{{ show.originalName }}</p>
          <p v-if="show.tagline?.trim()" class="tagline">“{{ show.tagline }}”</p>
          <p class="overview detail-overview">{{ show.overview || t('tv.noOverview') }}</p>
          <dl class="dossier-data tv-facts">
            <div><dt>{{ t('tv.firstAirDate') }}</dt><dd>{{ show.firstAirDate ? formatDate(show.firstAirDate, { dateStyle: 'long', timeZone: 'UTC' }) : t('tv.unknown') }}</dd></div>
            <div><dt>{{ t('tv.rating') }}</dt><dd class="rating">{{ show.voteAverage === undefined || show.voteCount === 0 ? t('tv.unknown') : formatNumber(show.voteAverage, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}</dd></div>
            <div><dt>{{ t('tv.status') }}</dt><dd>{{ statusLabel }}</dd></div>
            <div><dt>{{ t('tv.seasons') }}</dt><dd>{{ show.numberOfSeasons === undefined ? t('tv.unknown') : formatNumber(show.numberOfSeasons) }}</dd></div>
          </dl>
          <div class="detail-media-actions tv-media-actions">
            <button v-if="show.trailer" class="trailer-button" type="button" @click="trailerOpen = true">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5V7Z" /></svg>{{ t('movie.trailer.play') }}
            </button>
            <button class="detail-state-icon tv-watchlist-button" type="button" :class="{ active: inWatchlist }"
              :aria-pressed="inWatchlist" :aria-busy="membershipLoading || savingWatchlist" :disabled="membershipLoading || savingWatchlist"
              :aria-label="t(membershipLoading || savingWatchlist ? 'watchlist.saving' : watchlistError ? 'actions.retry' : inWatchlist ? 'watchlist.remove' : 'watchlist.add')"
              :aria-describedby="watchlistTooltipId" @click="toggleWatchlist">
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4V3Z" /><path v-if="inWatchlist" d="m9 9 2 2 4-4" /><path v-else d="M9 10h6m-3-3v6" /></svg>
              <span :id="watchlistTooltipId" class="detail-state-tooltip" role="tooltip">{{ t(membershipLoading || savingWatchlist ? 'watchlist.saving' : watchlistError ? 'actions.retry' : inWatchlist ? 'watchlist.joined' : 'watchlist.notJoined') }}</span>
            </button>
          </div>
          <p v-if="watchlistError" class="browse-error" role="alert">{{ watchlistError }}</p>
          <p v-if="show.stale" class="freshness" role="status">{{ t('tv.stale') }}</p>
        </div>
      </div>
      <div v-if="show.seasons.length" class="tv-season-section">
        <TvSeasonSelector v-model="selectedSeason" :seasons="show.seasons" />
        <p v-if="seasonLoading" class="movie-state" role="status">{{ t('tv.loadingSeason') }}</p>
        <div v-else-if="seasonError" class="movie-state" role="alert"><p>{{ seasonError }}</p><button class="outline-button" type="button" @click="loadSeason">{{ t('actions.retry') }}</button></div>
        <template v-else-if="season">
          <p v-if="season.stale" class="freshness" role="status">{{ t('tv.stale') }}</p>
          <TvEpisodeList v-if="season.episodes.length" :episodes="season.episodes" @open="selectedEpisode = $event" />
          <p v-else class="movie-state">{{ t('tv.noEpisodes') }}</p>
        </template>
      </div>
      <p v-else class="movie-state">{{ t('tv.noSeasons') }}</p>
      <MediaTrailerDialog v-if="trailerOpen && show.trailer" :trailer="show.trailer" :title="show.name" @close="trailerOpen = false" />
      <TvEpisodeDetailDialog v-if="selectedEpisode" :episode="selectedEpisode" @close="selectedEpisode = null" />
    </article>
  </section>
</template>
