<script setup lang="ts">
import type { TvShowSummary, TrackedMoviePreference } from '@movie-hub/contract';
import { ref, watch } from 'vue';
import { useI18n } from '../../i18n';

const props = defineProps<{
  show: TvShowSummary;
  updating?: boolean;
}>();
const emit = defineEmits<{
  preference: [value: TrackedMoviePreference];
  open: [
        tmdbId: number,
  ];
}>();
const { t, formatDate, formatNumber } = useI18n();
const imageFailed = ref(false);
watch(() => props.show.posterUrl, () => {
  imageFailed.value = false;
});
</script>

<template>
  <article class="movie-card catalog-card tv-catalog-card">
    <button class="tv-show-card" type="button" :aria-label="t('tv.viewDetails', { name: show.name })" @click="emit('open', show.tmdbId)">
      <span class="poster-frame">
        <img v-if="show.posterUrl && !imageFailed" :src="show.posterUrl" :alt="show.name" loading="lazy" @error="imageFailed = true" />
        <span v-else class="poster-placeholder">{{ t('tv.imageUnavailable') }}</span>
      </span>
      <span class="movie-copy">
        <span class="tv-card-name" :title="show.name || show.originalName">{{ show.name || show.originalName || t('tv.unnamed') }}</span>
        <span class="movie-meta">
          <time v-if="show.firstAirDate" :datetime="show.firstAirDate">{{ formatDate(show.firstAirDate) }}</time><span v-else>{{ t('tv.unknown') }}</span>
          <span v-if="show.voteAverage !== undefined && show.voteAverage > 0" class="rating" :aria-label="t('movie.rating', { rating: formatNumber(show.voteAverage, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })"><span aria-hidden="true">★ {{ formatNumber(show.voteAverage, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }}</span></span>
          <span v-else class="rating rating-missing" :aria-label="t('movie.ratingUnavailable')">—</span>
        </span>
      </span>
    </button>
            <div
              class="preference-control"
              role="group"
              :aria-label="t('a11y.moviePreference', { title: show.name })"
            >
              <button
                type="button"
                class="preference-button"
                :class="{ active: show.userPreference === 'liked' }"
                :aria-label="
                  t(show.userPreference === 'liked' ? 'movie.preference.clearLiked' : 'movie.preference.like')
                "
                :aria-pressed="show.userPreference === 'liked'"
                :disabled="updating"
                @click.stop="emit('preference', 'liked')"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M12 20.5 3.8 12.9A5.4 5.4 0 0 1 11.4 5l.6.7.6-.7a5.4 5.4 0 0 1 7.6 7.9L12 20.5Z" />
                </svg>
              </button>
              <button
                type="button"
                class="preference-button dislike"
                :class="{ active: show.userPreference === 'disliked' }"
                :aria-label="
                  t(show.userPreference === 'disliked' ? 'movie.preference.clearDisliked' : 'movie.preference.dislike')
                "
                :aria-pressed="show.userPreference === 'disliked'"
                :disabled="updating"
                @click.stop="emit('preference', 'disliked')"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path
                    d="M7.2 3h8.9a2 2 0 0 1 1.9 1.4l1.7 5.1a3 3 0 0 1-2.8 4h-3l.5 3.7a2.4 2.4 0 0 1-4.4 1.5L6.7 13H4a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2.2L7.2 3Zm0 2.5v5.2l4.5 7.1-.7-5.3a1.3 1.3 0 0 1 1.3-1.5h4.6a.5.5 0 0 0 .5-.7l-1.6-4.8H7.2Z"
                  />
                </svg>
              </button>
            </div>
  </article>
</template>
