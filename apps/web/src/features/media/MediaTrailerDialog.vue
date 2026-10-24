<script setup lang="ts">
import type { MovieTrailer } from '@movie-hub/contract';
import { onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ trailer: MovieTrailer; title: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const dialog = ref<HTMLDialogElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const titleId = useId();
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
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="trailer-panel media-trailer-dialog" :aria-labelledby="titleId" @cancel.prevent="emit('close')" @click.self="emit('close')">
      <div class="trailer-panel-heading">
        <div><p class="eyebrow">{{ t('media.trailer.eyebrow') }}</p><h2 :id="titleId">{{ trailer.name }}</h2></div>
        <button ref="closeButton" class="text-button" type="button" @click="emit('close')">{{ t('movie.trailer.close') }}</button>
      </div>
      <div class="trailer-frame">
        <iframe :src="`https://www.youtube-nocookie.com/embed/${encodeURIComponent(props.trailer.providerVideoId)}?autoplay=1`"
          :title="t('movie.trailer.playerTitle', { title })" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
      </div>
    </dialog>
  </Teleport>
</template>
