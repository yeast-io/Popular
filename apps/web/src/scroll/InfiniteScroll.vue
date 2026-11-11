<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from '../i18n';
import { useInfiniteScroll } from './infinite-scroll.composable';

const props = defineProps<{ loading: boolean; disabled?: boolean; failed?: boolean }>();
const emit = defineEmits<{ load: [] }>();
const { t } = useI18n();
const target = ref<HTMLElement | null>(null);
useInfiniteScroll({
  target,
  enabled: () => !props.loading && !props.disabled && !props.failed,
  load: () => emit('load'),
});
</script>

<template>
  <div ref="target" class="infinite-scroll" :aria-busy="loading">
    <span v-if="loading" class="infinite-scroll-status" role="status">
      <span class="infinite-scroll-spinner" aria-hidden="true" />{{ t('actions.loadingMore') }}
    </span>
    <button v-else-if="failed" class="text-button" type="button" :disabled="disabled" @click="emit('load')">{{ t('actions.retry') }}</button>
  </div>
</template>

<style scoped>
.infinite-scroll { display: grid; place-items: center; min-height: 40px; margin-top: 12px; }
.infinite-scroll-status { display: inline-flex; align-items: center; gap: 8px; color: var(--muted, #8e908b); font-size: .78rem; }
.infinite-scroll-spinner { width: 12px; height: 12px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: infinite-scroll-spin .8s linear infinite; }
@keyframes infinite-scroll-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .infinite-scroll-spinner { animation: none; } }
</style>
