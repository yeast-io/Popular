<script setup lang="ts">

defineProps<{ name: 'profile' | 'language' | 'ai' | 'preferences' | 'resources' | 'downloads' | 'keys' | 'notifications' }>();
const paths = {
  language: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4.8 5 4.8 13 0 18-4.8-5-4.8-13 0-18Z',
  preferences: 'M4 5h16M4 12h16M4 19h16M8 3v4M16 10v4M10 17v4',
  profile: 'M20 21v-2a7 7 0 0 0-14 0v2M13 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  ai: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  resources: 'M10 4H4v16h16V8H10V4ZM4 8h16M8 12h8M8 16h5',
  downloads: 'M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  keys: 'M15 3a6 6 0 0 0-5.4 8.6L3 18.2V21h3v-3h3v-3l2.4-2.4A6 6 0 1 0 15 3ZM17 7h.01',
  notifications: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
};
</script>
<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name]" />
  </svg>
</template>
