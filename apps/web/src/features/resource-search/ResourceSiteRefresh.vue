<script setup lang="ts">
import { RESOURCE_REFRESH_INTERVAL_MS } from '@movie-hub/contract';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ site: string; name: string; loading: boolean; count?: number | undefined; retryAt?: number | undefined }>();
const emit = defineEmits<{ refresh: [] }>();
const { t, formatNumber } = useI18n();
const now = ref(Date.now());
const deadline = ref(0);
const remaining = computed(() => Math.max(0, Math.ceil((deadline.value - now.value) / 1000)));
watch(() => props.retryAt, (value) => {
  if (value === undefined || !Number.isFinite(value)) return;
  now.value = Date.now();
  deadline.value = value;
}, { immediate: true });
let timer: ReturnType<typeof setInterval> | undefined;
function refresh() {
  if (props.loading || remaining.value) return;
  now.value = Date.now();
  deadline.value = now.value + RESOURCE_REFRESH_INTERVAL_MS;
  emit('refresh');
}
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 250);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <button class="release-site-refresh" type="button" :disabled="loading || remaining > 0"
    :aria-label="t('resourceSelection.refreshSite', { name })" @click.stop.prevent="refresh">
    <span>{{ remaining ? t('resourceSelection.refreshCountdown', { seconds: remaining }) : t('resourceSelection.refresh') }}</span>
    <span v-if="count !== undefined" class="release-site-count" :aria-label="t('resourceSelection.releaseCount', { count })">{{ formatNumber(count) }}</span>
  </button>
</template>
