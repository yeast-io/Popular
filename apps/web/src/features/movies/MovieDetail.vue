<script setup lang="ts">
import type {
  ApiError, MovieDetail, MovieRelease, MovieReleaseListResponse, MovieResourceCheckResponse, MovieStatus, TrackedMovieStatus,
} from '@movie-hub/contract';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
const resourceCheck = ref<MovieResourceCheckResponse | null>(null);
const resourceError = ref('');
const releases = ref<MovieRelease[]>([]);
const releasesOpen = ref(false);
const releasesLoading = ref(false);
const releasesError = ref('');
const releaseDialog = ref<HTMLElement | null>(null);
const releaseCloseButton = ref<HTMLButtonElement | null>(null);
let requestController: AbortController | undefined;
let resourcePoll: number | undefined;
let releaseTrigger: HTMLElement | null = null;
let previousBodyOverflow = '';
const detailStyle = computed(() => {
  const hue = 14 + (props.tmdbId % 4) * 11;
  return { '--movie-accent': `hsl(${hue} 88% 58%)`, '--movie-accent-rgb': hue < 30 ? '242, 82, 45' : '242, 151, 45' };
});
const statusOptions = computed(() => [
  ['watched', t('movie.status.watched')],
  ['interested', t('movie.status.interested')],
  ['not_interested', t('movie.status.notInterested')],
] as const);

onMounted(() => { void load(); if (props.authenticated) void loadResourceCheck(); });
onBeforeUnmount(() => {
  requestController?.abort();
  stopResourcePolling();
  unlockPageScroll();
});
watch([() => props.tmdbId, locale], () => {
  releases.value = [];
  closeReleases(false);
  releasesError.value = '';
  void load();
  if (props.authenticated) void loadResourceCheck();
});
watch(() => props.authenticated, (authenticated) => {
  if (authenticated) void loadResourceCheck();
  else { resourceCheck.value = null; stopResourcePolling(); }
});

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

async function loadResourceCheck() {
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/resources/mteam`, { credentials: 'include' });
    const body = await response.json() as MovieResourceCheckResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.checkMovieResource');
    resourceCheck.value = body as MovieResourceCheckResponse;
    resourceError.value = '';
    if (resourceCheck.value.checking) scheduleResourcePoll();
    else stopResourcePolling();
  } catch (error) {
    resourceError.value = localizedErrorMessage(error, 'errors.checkMovieResource');
    stopResourcePolling();
  }
}

async function recheckResource() {
  if (!props.authenticated) { emit('requireLogin'); return; }
  if (resourceCheck.value?.checking) return;
  resourceError.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/resources/mteam/refresh`, {
      method: 'POST', credentials: 'include',
    });
    const body = await response.json() as MovieResourceCheckResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.checkMovieResource');
    resourceCheck.value = body as MovieResourceCheckResponse;
    scheduleResourcePoll();
  } catch (error) {
    resourceError.value = localizedErrorMessage(error, 'errors.checkMovieResource');
  }
}

function scheduleResourcePoll() {
  stopResourcePolling();
  resourcePoll = window.setTimeout(() => void loadResourceCheck(), 1_000);
}

function stopResourcePolling() {
  if (resourcePoll !== undefined) window.clearTimeout(resourcePoll);
  resourcePoll = undefined;
}

function resourceStatusLabel(): string {
  const check = resourceCheck.value;
  if (!check) return t('movie.resource.pending');
  if (check.checking) return t('movie.resource.checking');
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

function posterResourceState(): 'available' | 'checking' | 'error' | 'pending' | 'unavailable' | 'unmatchable' {
  const check = resourceCheck.value;
  if (!check) return 'pending';
  if (check.checking) return 'checking';
  if (check.availability === 'available') return 'available';
  if (check.availability === 'unavailable') return 'unavailable';
  if (check.availability === 'unmatchable') return 'unmatchable';
  if (check.lastAttemptStatus === 'error') return 'error';
  return 'pending';
}

function posterResourceLabel(): string {
  return t(`movie.resource.badge.${posterResourceState()}`);
}

async function showReleases() {
  if (!props.authenticated) { emit('requireLogin'); return; }
  if (releasesLoading.value) return;
  releaseTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  releasesOpen.value = true;
  lockPageScroll();
  await nextTick();
  releaseCloseButton.value?.focus();
  releasesLoading.value = true;
  releasesError.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/movies/${props.tmdbId}/resources/mteam/releases`, { credentials: 'include' });
    const body = await response.json() as MovieReleaseListResponse | ApiError;
    if (!response.ok) throw localizedApiError(body, 'errors.loadMovieReleases');
    const result = body as MovieReleaseListResponse;
    releases.value = result.releases;
    resourceCheck.value = {
      provider: 'mteam', checking: false, availability: result.availability,
      lastAttemptStatus: 'success', checkedAt: result.queriedAt,
    };
  } catch (error) {
    releases.value = [];
    releasesError.value = localizedErrorMessage(error, 'errors.loadMovieReleases');
  } finally {
    releasesLoading.value = false;
  }
}

function closeReleases(restoreFocus = true) {
  if (!releasesOpen.value) return;
  releasesOpen.value = false;
  unlockPageScroll();
  if (restoreFocus) {
    void nextTick(() => releaseTrigger?.focus());
  }
}

function lockPageScroll() {
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
}

function unlockPageScroll() {
  if (!releasesOpen.value && document.body.style.overflow !== 'hidden') return;
  document.body.style.overflow = previousBodyOverflow;
}

function handleReleaseDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeReleases();
    return;
  }
  if (event.key !== 'Tab' || !releaseDialog.value) return;
  const focusable = [...releaseDialog.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  if (!focusable.length) {
    event.preventDefault();
    releaseDialog.value.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${formatNumber(amount, { maximumFractionDigits: amount >= 10 ? 1 : 2 })} ${units[unit]}`;
}

function discountLabel(value: string): string {
  const labels: Record<string, string> = {
    NORMAL: t('movie.releases.discount.normal'), PERCENT_70: '70%', PERCENT_50: '50%',
    FREE: t('movie.releases.discount.free'), _2X_FREE: `2× ${t('movie.releases.discount.free')}`,
    _2X: '2×', _2X_PERCENT_50: '2× / 50%',
  };
  return labels[value] ?? value;
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
          <button
            v-if="resourceCheck?.availability === 'available' && !resourceCheck.checking"
            class="poster-resource-badge"
            :class="`is-${posterResourceState()}`"
            type="button"
            :aria-label="resourceStatusLabel()"
            :title="resourceStatusLabel()"
            :disabled="releasesLoading"
            @click="showReleases"
          >
            <span class="poster-resource-dot" aria-hidden="true"></span>
            <span>{{ posterResourceLabel() }}</span>
          </button>
          <span
            v-else
            class="poster-resource-badge"
            :class="`is-${posterResourceState()}`"
            :title="resourceStatusLabel()"
          >
            <span class="poster-resource-dot" aria-hidden="true"></span>
            <span>{{ posterResourceLabel() }}</span>
          </span>
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
          <div class="resource-check-panel">
            <div>
              <strong>{{ t('movie.resource.sectionTitle') }}</strong>
              <button
                v-if="resourceCheck?.availability === 'available' && !resourceCheck.checking"
                class="resource-status resource-status-button"
                :class="{ error: resourceCheck.lastAttemptStatus === 'error' }"
                type="button"
                :disabled="releasesLoading"
                @click="showReleases"
              >
                {{ resourceStatusLabel() }}
              </button>
              <p v-else class="resource-status" :class="{ error: resourceCheck?.lastAttemptStatus === 'error' }" role="status">
                {{ resourceStatusLabel() }}
              </p>
            </div>
            <button class="outline-button" type="button" :disabled="resourceCheck?.checking" @click="recheckResource">
              {{ resourceCheck?.checking ? t('movie.resource.checking') : t('movie.resource.recheck') }}
            </button>
          </div>
          <p v-if="resourceError" class="browse-error" role="alert">{{ resourceError }}</p>
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
    <Teleport to="body">
      <div v-if="releasesOpen" class="release-dialog-backdrop" @click.self="closeReleases()">
        <section
          ref="releaseDialog"
          class="release-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="release-dialog-title"
          :aria-busy="releasesLoading"
          tabindex="-1"
          @keydown="handleReleaseDialogKeydown"
        >
          <div class="release-panel-heading">
            <div>
              <p class="eyebrow">M-Team</p>
              <h2 id="release-dialog-title">{{ t('movie.releases.title') }}</h2>
            </div>
            <button ref="releaseCloseButton" class="text-button" type="button" @click="closeReleases()">
              {{ t('movie.releases.close') }}
            </button>
          </div>
          <div class="release-panel-content">
            <p v-if="releasesLoading" class="muted-copy" role="status">{{ t('movie.releases.loading') }}</p>
            <p v-else-if="releasesError" class="browse-error" role="alert">{{ releasesError }}</p>
            <p v-else-if="!releases.length" class="muted-copy" role="status">{{ t('movie.releases.empty') }}</p>
            <ol v-else class="release-list">
              <li v-for="release in releases" :key="release.id" class="release-card">
                <h3>{{ release.title }}</h3>
                <dl class="release-facts">
                  <div v-if="release.sizeBytes !== undefined"><dt>{{ t('movie.releases.size') }}</dt><dd>{{ formatBytes(release.sizeBytes) }}</dd></div>
                  <div><dt>{{ t('movie.releases.seeders') }}</dt><dd>{{ formatNumber(release.seeders) }}</dd></div>
                  <div v-if="release.leechers !== undefined"><dt>{{ t('movie.releases.leechers') }}</dt><dd>{{ formatNumber(release.leechers) }}</dd></div>
                  <div v-if="release.publishedAt"><dt>{{ t('movie.releases.publishedAt') }}</dt><dd>{{ release.publishedAt }}</dd></div>
                  <div v-if="release.discount"><dt>{{ t('movie.releases.discount') }}</dt><dd>{{ discountLabel(release.discount) }}</dd></div>
                  <div v-if="release.resolution"><dt>{{ t('movie.releases.resolution') }}</dt><dd>{{ release.resolution }}</dd></div>
                  <div v-if="release.medium"><dt>{{ t('movie.releases.medium') }}</dt><dd>{{ release.medium }}</dd></div>
                  <div v-if="release.videoCodec"><dt>{{ t('movie.releases.videoCodec') }}</dt><dd>{{ release.videoCodec }}</dd></div>
                  <div v-if="release.audioCodec"><dt>{{ t('movie.releases.audioCodec') }}</dt><dd>{{ release.audioCodec }}</dd></div>
                </dl>
                <div v-if="release.tags.length" class="release-tags">
                  <span v-for="tag in release.tags" :key="tag">{{ tag }}</span>
                </div>
              </li>
            </ol>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>
