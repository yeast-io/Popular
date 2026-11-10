<script setup lang="ts">
import { useI18n } from '../../i18n';

const props = defineProps<{ site: string; name: string; loading: boolean; count?: number | undefined }>();
const emit = defineEmits<{ refresh: [] }>();
const { t, formatNumber } = useI18n();
function refresh() {
  if (props.loading) return;
  emit('refresh');
}
</script>

<template>
  <button class="release-site-refresh" type="button" :disabled="loading"
    :aria-label="t('resourceSelection.refreshSite', { name })" @click.stop.prevent="refresh">
    <span>{{ t('resourceSelection.refresh') }}</span>
    <span v-if="count !== undefined" class="release-site-count" :aria-label="t('resourceSelection.releaseCount', { count })">{{ formatNumber(count) }}</span>
  </button>
</template>
