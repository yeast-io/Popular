<script setup lang="ts">
import type { AgentIconName } from './agent-icon.types';

defineProps<{ name: AgentIconName }>();
const paths: Record<AgentIconName, string> = {
  'overview': 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  'resource-sites': 'M12 3 2 8l10 5 10-5-10-5ZM2 12l10 5 10-5M2 16l10 5 10-5',
  'downloaders': 'M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5',
  'tasks': 'M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1',
  'settings': 'M4 7h16M4 17h16M8 4v6M16 14v6',
  'arrow': 'M5 12h14m-6-6 6 6-6 6',
  'shield': 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
  'check': 'm5 12 4 4L19 6',
  'link': 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  'refresh': 'M20 7V3l-3 3a8 8 0 1 0 3 8M20 3h-4',
};
</script>
<template>
  <svg
    class="agent-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]" />
  </svg>
</template>
