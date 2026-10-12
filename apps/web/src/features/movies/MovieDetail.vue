<script setup lang="ts">
import type { ApiError, MovieDetail, MovieStatus, TrackedMovieStatus } from '@movie-hub/contract';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedApiError, localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const props = defineProps<{ tmdbId: number; authenticated: boolean }>();
const emit = defineEmits<{ back: []; requireLogin: [] }>();
const { apiBaseUrl } = loadWebConfig();
const { formatDate, formatDuration, formatNumber, locale, t } = useI18n();
const movie = ref<MovieDetail | null>(null);
const loading = ref(true);
const updating = ref(false);
const errorMessage = ref('');
let requestController: AbortController | undefined;
const detailStyle = computed(() => {
  const hue = 14 + (props.tmdbId % 4) * 11;
  return { '--movie-accent': `hsl(${hue} 88% 58%)`, '--movie-accent-rgb': hue < 30 ? '242, 82, 45' : '242, 151, 45' };
});
const statusOptions = computed(() => [
  ['watched', t('movie.status.watched')],
  ['interested', t('movie.status.interested')],
  ['not_interested', t('movie.status.notInterested')],
] as const);

onMounted(() => void load());
onBeforeUnmount(() => requestController?.abort());
watch([() => props.tmdbId, locale], () => void load());

async function load() {
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  loading.value = true; errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/movies/${props.tmdbId}?locale=${locale.value}`, { credentials: 'include', signal: controller.signal });
    const body = await response.json() as MovieDetail | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.loadMovieDetails');
    movie.value = body as MovieDetail;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) errorMessage.value = localizedErrorMessage(error, 'errors.loadMovieDetails');
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}

async function setStatus(status: TrackedMovieStatus) {
  if (!props.authenticated) { emit('requireLogin'); return; }
  if (!movie.value || updating.value) return;
  const previous = movie.value.userStatus;
  const next: MovieStatus = previous === status ? 'unwatched' : status;
  movie.value.userStatus = next; updating.value = true; errorMessage.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/status`, {
      method: next === 'unwatched' ? 'DELETE' : 'PUT', credentials: 'include',
      ...(next === 'unwatched' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: next }) }),
    });
    if (!response.ok) throw await localizedResponseError(response);
  } catch (error) {
    movie.value.userStatus = previous;
    errorMessage.value = localizedErrorMessage(error, 'errors.saveMovieStatus');
  } finally { updating.value = false; }
}

function releaseDateLabel(releaseDate?: string): string {
  return releaseDate
    ? formatDate(releaseDate, { dateStyle: 'long', timeZone: 'UTC' })
    : t('movie.detail.missing');
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
        :style="{ backgroundImage: `linear-gradient(90deg, #0b0c0d 0%, rgba(11,12,13,.45) 55%, #0b0c0d 100%), url(${movie.backdropUrl})` }"
      ></div>
      <div class="detail-hero">
        <div class="detail-poster">
          <img v-if="movie.posterUrl" :src="movie.posterUrl" :alt="t('a11y.moviePoster', { title: movie.title })" />
          <div v-else class="poster-placeholder"><span>{{ t('movie.posterUnavailable') }}</span></div>
          <span class="poster-index">FILE {{ String(movie.tmdbId).padStart(6, '0') }}</span>
        </div>
        <div class="detail-copy">
          <p class="eyebrow">{{ t('movie.detail.eyebrow') }}</p>
          <h1>{{ movie.title }}</h1>
          <p v-if="movie.originalTitle && movie.originalTitle !== movie.title" class="detail-original">{{ movie.originalTitle }}</p>
          <p v-if="movie.tagline" class="tagline">“{{ movie.tagline }}”</p>
          <dl class="dossier-data">
            <div>
              <dt>{{ t('movie.detail.release') }}</dt>
              <dd>{{ releaseDateLabel(movie.releaseDate) }}</dd>
            </div>
            <div>
              <dt>{{ t('movie.detail.runtime') }}</dt>
              <dd>{{ movie.runtimeMinutes === undefined ? t('movie.detail.missing') : formatDuration(movie.runtimeMinutes) }}</dd>
            </div>
            <div>
              <dt>{{ t('movie.detail.score') }}</dt>
              <dd class="rating">{{ ratingLabel(movie.voteAverage) }}</dd>
            </div>
            <div>
              <dt>{{ t('movie.detail.votes') }}</dt>
              <dd>{{ movie.voteCount === undefined ? t('movie.detail.missing') : formatNumber(movie.voteCount) }}</dd>
            </div>
          </dl>
          <div class="genre-list">
            <span v-for="genre in movie.genres" :key="genre.tmdbId">{{ genre.name }}</span>
            <span v-if="!movie.genres.length" class="genre-missing">{{ t('movie.detail.genresMissing') }}</span>
          </div>
          <div class="status-control detail-status" role="group" :aria-label="t('a11y.movieStatus', { title: movie.title })">
            <button
              v-for="option in statusOptions"
              :key="option[0]"
              type="button"
              :class="{ active: movie.userStatus === option[0] }"
              :aria-pressed="movie.userStatus === option[0]"
              :disabled="updating"
              @click="setStatus(option[0])"
            >
              {{ option[1] }}
            </button>
          </div>
          <p v-if="errorMessage" class="browse-error" role="alert">{{ errorMessage }}</p>
        </div>
      </div>
      <div class="detail-sections">
        <section>
          <p class="eyebrow">{{ t('movie.detail.storyEyebrow') }}</p>
          <h2>{{ t('movie.detail.story') }}</h2>
          <p class="overview">{{ movie.overview || t('movie.detail.overviewMissing') }}</p>
        </section>
        <section>
          <p class="eyebrow">{{ t('movie.detail.directorsEyebrow') }}</p>
          <h2>{{ t('movie.detail.directors') }}</h2>
          <div class="people-list">
            <div v-for="person in movie.directors" :key="person.tmdbId" class="person-card">
              <img v-if="person.profileUrl" :src="person.profileUrl" :alt="person.name" />
              <div v-else class="person-placeholder">{{ person.name.slice(0, 1) }}</div>
              <strong>{{ person.name }}</strong>
            </div>
            <p v-if="!movie.directors.length" class="muted-copy">{{ t('movie.detail.directorsMissing') }}</p>
          </div>
        </section>
        <section class="cast-section">
          <p class="eyebrow">{{ t('movie.detail.castEyebrow') }}</p>
          <h2>{{ t('movie.detail.cast') }}</h2>
          <div class="people-list">
            <div v-for="person in movie.cast" :key="`${person.tmdbId}-${person.character}`" class="person-card">
              <img v-if="person.profileUrl" :src="person.profileUrl" :alt="person.name" />
              <div v-else class="person-placeholder">{{ person.name.slice(0, 1) }}</div>
              <strong>{{ person.name }}</strong
              ><span>{{ person.character || t('movie.detail.characterMissing') }}</span>
            </div>
            <p v-if="!movie.cast.length" class="muted-copy">{{ t('movie.detail.castMissing') }}</p>
          </div>
        </section>
      </div>
      <p v-if="movie.stale" class="stale-note" role="status">
        {{ t('movie.detail.staleCache', { date: syncedAtLabel(movie.detailSyncedAt) }) }}
      </p>
    </article>
  </section>
</template>
