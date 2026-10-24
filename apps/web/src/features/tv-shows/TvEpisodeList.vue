<script setup lang="ts">
import type { TvEpisode } from '@movie-hub/contract';
import { ref, watch } from 'vue';
import { useI18n } from '../../i18n';

const props = defineProps<{
  episodes: TvEpisode[];
}>();
const emit = defineEmits<{
  open: [
        episode: TvEpisode,
  ];
}>();
const { t } = useI18n();
const failed = ref(new Set<number>());
watch(() => props.episodes, () => {
  failed.value = new Set();
});
function openEpisode(episode: TvEpisode, event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
  emit('open', episode);
}
</script>

<template>
  <div class="tv-episodes">
    <button v-for="episode in episodes" :key="episode.tmdbId" class="tv-episode-card" type="button" @click="openEpisode(episode, $event)">
      <span class="tv-episode-image">
        <img v-if="episode.stillUrl && !failed.has(episode.tmdbId)" :src="episode.stillUrl" :alt="episode.name" loading="lazy" @error="failed.add(episode.tmdbId)" />
        <span v-else>{{ t('tv.imageUnavailable') }}</span>
      </span>
      <span class="tv-episode-copy">
        <span class="eyebrow">{{ t('tv.episodeNumber', { number: episode.episodeNumber }) }}</span>
        <strong>{{ episode.name || t('tv.unnamed') }}</strong>
        <span class="tv-episode-excerpt">{{ episode.overview || t('tv.noOverview') }}</span>
      </span>
    </button>
  </div>
</template>
