<script setup lang="ts">
withDefaults(defineProps<{ showMark?: boolean }>(), { showMark: true });
</script>

<template>
  <span class="brand-logo">
    <img v-if="showMark" class="brand-logo-mark" src="/favicon.svg" alt="" />
    <span class="brand-logo-word">popular<span class="brand-logo-dot">.</span></span>
  </span>
</template>

<style scoped>
.brand-logo {
  display: inline-flex;
  align-items: center;
  gap: 11px;
  font-size: 30px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -1.6px;
}
.brand-logo-mark {
  display: block;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
}
.brand-logo-word { white-space: nowrap; }
.brand-logo-dot { color: var(--brand); }
@media (max-width: 480px) {
  .brand-logo { gap: 8px; font-size: 26px; }
  .brand-logo-mark { width: 29px; height: 29px; }
}
</style>
