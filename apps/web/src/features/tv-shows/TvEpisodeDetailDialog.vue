<script setup lang="ts">
import type { TvEpisode } from '@movie-hub/contract';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from '../../i18n';

defineProps<{
  episode: TvEpisode;
}>();
const emit = defineEmits<{
  close: [
  ];
}>();
const { t, formatDate, formatNumber, formatDuration } = useI18n();
const dialog = ref<HTMLDialogElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const failed = ref(false);
let trigger: HTMLElement | null = null;
let previousOverflow = '';
onMounted(() => {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  dialog.value?.showModal();
  closeButton.value?.focus();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  document.body.style.overflow = previousOverflow;
  if (trigger?.isConnected)
    trigger.focus();
});
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="tv-episode-dialog" aria-labelledby="tv-episode-dialog-title" aria-describedby="tv-episode-dialog-overview" @cancel.prevent="emit('close')" @click.self="emit('close')">
      <div class="tv-dialog-content">
        <header class="tv-dialog-heading">
          <div>
            <p class="eyebrow">{{ episode.seasonNumber === 0 ? t('tv.specialEpisode', { episode: episode.episodeNumber }) : t('tv.seasonEpisode', { season: episode.seasonNumber, episode: episode.episodeNumber }) }}</p>
            <h2 id="tv-episode-dialog-title">{{ episode.name || t('tv.unnamed') }}</h2>
          </div>
          <button ref="closeButton" class="tv-dialog-close" type="button" :aria-label="t('tv.close')" :title="t('tv.close')" @click="emit('close')">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <img v-if="episode.stillUrl && !failed" class="tv-dialog-image" :src="episode.stillUrl" :alt="episode.name" @error="failed = true" />
        <dl class="tv-dialog-facts tv-facts">
          <div><dt>{{ t('tv.airDate') }}</dt><dd>{{ episode.airDate ? formatDate(episode.airDate) : t('tv.unknown') }}</dd></div>
          <div><dt>{{ t('tv.runtime') }}</dt><dd>{{ episode.runtimeMinutes === undefined ? t('tv.unknown') : formatDuration(episode.runtimeMinutes) }}</dd></div>
          <div><dt>{{ t('tv.rating') }}</dt><dd class="tv-dialog-rating">{{ episode.voteAverage === undefined || episode.voteCount === 0 ? t('tv.unknown') : formatNumber(episode.voteAverage, { maximumFractionDigits: 1 }) }}</dd></div>
        </dl>
        <p id="tv-episode-dialog-overview" class="tv-overview">{{ episode.overview || t('tv.noOverview') }}</p>
      </div>
    </dialog>
  </Teleport>
</template>
