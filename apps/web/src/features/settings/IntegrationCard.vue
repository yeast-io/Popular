<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import IntegrationDefaultAction from '../integrations/IntegrationDefaultAction.vue';
import { t } from '../../i18n';
import { getIntegrationLogo } from './integration-logos';

const props = defineProps<{
  id: string;
  title: string;
  badge: string;
  description?: string;
  statusLabel: string;
  statusClass: string;
  loading?: boolean;
  busy?: boolean;
  configured?: boolean;
  notice?: string;
  actionLabel?: string | undefined;
  forceOpen?: boolean;
}>();
const emit = defineEmits<{ open: [] }>();
const defaultCategory = computed(() => {
  return ['mteam', 'hdarea'].includes(
    props.id
  )
    ? 'resource' as const
    : ['qbittorrent', 'transmission'].includes(
        props.id
      )
        ? 'downloader' as const
        : props.id === 'openai' ? 'ai' as const : undefined;
});
const expanded = ref(false);
const logoFailed = ref(false);
const logoSrc = computed(() => getIntegrationLogo(props.id));
watch(logoSrc, () => {
  logoFailed.value = false;
});
watch(
  () => props.forceOpen,
  (value) => {
    if (value) expanded.value = true;
  },
  { immediate: true }
);
function toggle() {
  expanded.value = !expanded.value;
  if (expanded.value) emit('open');
}
</script>
<template>
  <section
    class="settings-card integration-card"
    :class="{ 'is-expanded': expanded }"
    :aria-labelledby="`${id}-title`"
    :aria-busy="loading || busy"
  >
    <div class="connection-card-heading">
      <span class="connection-badge" :class="id" aria-hidden="true">
        <img
          v-if="logoSrc && !logoFailed"
          class="connection-logo"
          :src="logoSrc"
          alt=""
          width="28"
          height="28"
          @error="logoFailed = true"
        />
        <span v-else>{{ badge }}</span>
      </span>
      <div class="connection-copy">
        <div class="integration-title-row">
          <h3 :id="`${id}-title`">{{ title }}</h3>
          <span class="integration-status" :class="statusClass">{{ statusLabel }}</span>
        </div>
        <p v-if="description">{{ description }}</p>
      </div>
      <IntegrationDefaultAction v-if="configured && defaultCategory" :id="id" :category="defaultCategory" :status="statusClass" :disabled="loading || busy" />
      <slot name="actions" />
      <button
        class="integration-disclosure"
        type="button"
        :disabled="loading || busy"
        :aria-expanded="expanded"
        :aria-controls="`${id}-body`"
        @click="toggle"
      >
        {{
          expanded
            ? t('settings.collapse')
            : (actionLabel ?? (configured ? t('settings.manage') : t('settings.configure')))
        }}
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="m7 4 6 6-6 6" />
        </svg>
      </button>
    </div>
    <p v-if="notice && !expanded" class="error settings-message connection-card-notice" role="alert">{{ notice }}</p>
    <div v-show="expanded" :id="`${id}-body`" class="connection-card-body"><slot /></div>
  </section>
</template>
