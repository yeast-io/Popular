<script setup lang="ts">
import { useId } from 'vue';
import { useResourceNotificationTooltip } from './resource-notification-tooltip.composable';

defineProps<{ label: string; icon: 'search' | 'warning' | 'check' | 'info' | 'clock'; tone?: 'notified' | 'warning' | undefined }>();
const tooltipId = useId();
const { root, hovered, visible, enter, focus, blur, toggle } = useResourceNotificationTooltip();
</script>

<template>
  <span ref="root" class="resource-notification-info" @mouseenter="enter" @mouseleave="hovered = false">
    <button class="resource-notification-icon" :class="tone" type="button" :aria-label="label"
      :aria-describedby="visible ? tooltipId : undefined" @focus="focus" @blur="blur" @click="toggle">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path v-if="icon === 'check'" d="m5 12 4 4L19 6" />
        <template v-else-if="icon === 'search'"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></template>
        <template v-else-if="icon === 'warning'"><path d="M10.3 4.9a2 2 0 0 1 3.4 0l7 12.1a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3Z" /><path d="M12 9v4m0 3h.01" /></template>
        <template v-else-if="icon === 'clock'"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></template>
        <template v-else><circle cx="12" cy="12" r="8" /><path d="M12 11v5m0-9h.01" /></template>
      </svg>
    </button>
    <span v-if="visible" :id="tooltipId" class="resource-notification-tooltip" role="tooltip">{{ label }}</span>
  </span>
</template>

<style scoped>
.resource-notification-info { display: inline-flex; }
.resource-notification-icon { display: grid; place-items: center; width: 40px; height: 40px; min-height: 0; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: #858a91; cursor: pointer; transition: color .2s ease, background .2s ease, border-color .2s ease; }
.resource-notification-icon svg { width: 18px; height: 18px; }
.resource-notification-icon.notified { color: #8bc5a3; }
.resource-notification-icon.warning { color: #d6b286; }
.resource-notification-icon:hover { color: #c5cad1; border-color: #a7acb226; background: #a7acb210; }
.resource-notification-icon:focus-visible { outline: 2px solid var(--brand); outline-offset: 4px; }
.resource-notification-tooltip { position: absolute; z-index: 5; right: 0; bottom: calc(100% + 8px); width: max-content; max-width: min(260px, calc(100vw - 48px)); padding: 8px 10px; border: 1px solid #35383b; border-radius: 6px; background: #1b1c1e; color: #c5cad1; font-size: 12px; font-weight: 400; line-height: 1.5; text-align: left; overflow-wrap: anywhere; box-shadow: 0 6px 18px #0004; }
.resource-notification-tooltip::after { content: ''; position: absolute; top: 100%; left: 0; width: 100%; height: 8px; }
@media (max-width: 600px) {
  .resource-notification-icon { width: 44px; height: 44px; }
}
</style>
