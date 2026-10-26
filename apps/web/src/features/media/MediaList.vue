<script setup lang="ts">
import type { WatchlistItem } from '@movie-hub/contract';
import { ref, useSlots, watch } from 'vue';
import { useI18n } from '../../i18n';

const slots = useSlots();
const props = defineProps<{ items: WatchlistItem[]; animateRemoval?: boolean }>();
const emit = defineEmits<{ open: [item: WatchlistItem] }>();
const { t, formatDate, formatNumber } = useI18n();
const failedPosters = ref(new Set<string>());
watch(() => props.items, () => {
  failedPosters.value = new Set();
});
function prepareRemoval(element: Element) {
  if (props.animateRemoval && element instanceof HTMLElement) {
    element.style.setProperty('--watchlist-row-height', `${element.getBoundingClientRect().height}px`);
  }
}
</script>
<template>
    <TransitionGroup tag="div" class="watchlist-entries" name="watchlist-remove" :css="animateRemoval" :duration="{ enter: 0, leave: 300 }" @before-leave="prepareRemoval">
      <div v-for="item in items" :key="`${item.mediaType}:${item.tmdbId}`" :class="{ 'watchlist-row': slots.actions }">
        <button class="watchlist-entry" type="button" :aria-label="t('watchlist.open', { title: item.title })" @click="emit('open', item)">
          <span class="watchlist-poster"><img v-if="item.posterUrl && !failedPosters.has(`${item.mediaType}:${item.tmdbId}`)" :src="item.posterUrl" alt="" loading="lazy" @error="failedPosters.add(`${item.mediaType}:${item.tmdbId}`)" /><span v-else>{{ t('tv.imageUnavailable') }}</span></span>
          <span class="watchlist-copy">
            <span class="watchlist-entry-heading"><span v-if="item.voteAverage !== undefined" class="watchlist-score" :aria-label="t('movie.rating', { rating: formatNumber(item.voteAverage, { maximumFractionDigits: 1 }) })">{{ formatNumber(item.voteAverage, { maximumFractionDigits: 1 }) }}<small>/10</small></span><span><strong>{{ item.title || t('tv.unnamed') }}</strong><time v-if="item.releaseDate" :datetime="item.releaseDate">{{ formatDate(item.releaseDate) }}</time><span v-else class="watchlist-date-missing">{{ t('watchlist.dateUnknown') }}</span></span></span>
            <span class="watchlist-overview">{{ item.overview || t('tv.noOverview') }}</span>
          </span>
        </button>
        <slot name="actions" :item="item" />
      </div>
    </TransitionGroup>
</template>
