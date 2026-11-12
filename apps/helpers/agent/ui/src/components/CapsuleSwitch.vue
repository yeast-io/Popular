<script setup lang="ts">
import type { CapsuleSwitchProps } from './capsule-switch.types';

defineProps<CapsuleSwitchProps>();
defineEmits<{ change: [] }>();
</script>
<template>
  <button
    type="button"
    class="capsule-switch"
    role="switch"
    :aria-checked="checked"
    :aria-label="label"
    :disabled="disabled"
    @click="$emit('change')"
  >
    <span />
  </button>
</template>
<style scoped>
.capsule-switch {
  width: 42px;
  height: 24px;
  min-height: 24px;
  padding: 3px;
  border-radius: 99px;
  background: var(--surface, #282828);
  border: 1px solid currentColor;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0;
  flex-shrink: 0;
}
.capsule-switch span {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: currentColor;
  transition: transform 150ms ease;
}
.capsule-switch[aria-checked='true'] {
  background: #f0522d;
  color: #111;
  border-color: #f0522d;
}
.capsule-switch[aria-checked='true'] span {
  transform: translateX(17px);
}
@media (prefers-reduced-motion: reduce) {
  .capsule-switch span {
    transition: none;
  }
}
</style>
