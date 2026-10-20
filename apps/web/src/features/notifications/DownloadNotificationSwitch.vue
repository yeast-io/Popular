<script setup lang="ts">
import { t } from '../../i18n';
defineProps<{ channel: string; enabled: boolean; disabled?: boolean }>();
const emit = defineEmits<{ change: [enabled: boolean] }>();
</script>
<template>
  <label class="download-notification-switch" :title="t('notifications.channelHint')">
    <span>{{ t('notifications.downloadToggle') }}</span>
    <input type="checkbox" role="switch" :checked="enabled" :disabled="disabled"
      :aria-label="t('notifications.channelToggle', { name: channel })"
      @change="emit('change', ($event.target as HTMLInputElement).checked)" />
    <span class="download-notification-track" aria-hidden="true"></span>
  </label>
</template>
<style scoped>
.download-notification-switch { position: relative; display: inline-flex; align-items: center; gap: 9px; flex-shrink: 0; color: #b9bfb3; font-size: .72rem; white-space: nowrap; cursor: pointer; }
.download-notification-switch input { position: absolute; right: 0; top: 50%; transform: translateY(-50%); width: 42px; height: 32px; min-height: 0; margin: 0; padding: 0; opacity: 0; cursor: pointer; }
.download-notification-track { box-sizing: border-box; display: block; width: 38px; height: 22px; padding: 2px; border: 1px solid #ffffff29; border-radius: 999px; background: #363b35; transition: background 150ms, border-color 150ms; pointer-events: none; }
.download-notification-track::after { content: ''; display: block; width: 16px; height: 16px; border-radius: 50%; background: #c9cfc2; transition: transform 150ms; }
input:checked + .download-notification-track { border-color: #dd6b50; background: #cb4c31; }
input:checked + .download-notification-track::after { transform: translateX(16px); background: #fff; }
input:focus-visible + .download-notification-track { outline: 2px solid #efa457; outline-offset: 3px; }
input:disabled { cursor: not-allowed; }
input:disabled + .download-notification-track { opacity: .45; }
@media (prefers-reduced-motion: reduce) { .download-notification-track, .download-notification-track::after { transition: none; } }
</style>
