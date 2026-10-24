<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, useId } from 'vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ modelValue: string; label: string; placeholder: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const { t } = useI18n();
const expanded = ref(false);
const container = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const toggle = ref<HTMLButtonElement | null>(null);
const panelId = useId();
const headerTarget = ref<HTMLElement | null>(null);
const visible = ref(true);

const active = computed(() => props.modelValue.trim().length > 0);
const toggleLabel = computed(() => expanded.value
  ? t('mediaSearch.close')
  : active.value ? t('mediaSearch.activeLabel', { label: props.label }) : props.label);

function closeSearch(restoreFocus = false) {
  expanded.value = false;
  if (restoreFocus) toggle.value?.focus();
}
async function toggleSearch() {
  if (expanded.value) {
    closeSearch(true);
    return;
  }
  expanded.value = true;
  await nextTick();
  if (expanded.value) input.value?.focus();
}
function outsideSearch(event: PointerEvent) {
  if (expanded.value && event.target instanceof Node && !container.value?.contains(event.target)) closeSearch();
}
onMounted(() => {
  document.addEventListener('pointerdown', outsideSearch);
  headerTarget.value = document.getElementById('header-media-search');
});
onActivated(() => {
  visible.value = true;
});
onDeactivated(() => {
  closeSearch();
  visible.value = false;
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outsideSearch);
  visible.value = false;
});
</script>

<template>
  <Teleport v-if="visible" :to="headerTarget ?? 'body'" :disabled="!headerTarget">
  <div ref="container" class="floating-media-search" :class="{ expanded }" @keydown.esc.stop.prevent="closeSearch(true)">
    <label v-show="expanded" :id="panelId" class="search-box floating-search-panel">
      <span class="sr-only">{{ label }}</span>
      <input ref="input" :value="modelValue" type="search" maxlength="100" :placeholder="placeholder" autocomplete="off"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
    </label>
    <button ref="toggle" class="floating-search-toggle" :class="{ active }" type="button" :aria-label="toggleLabel"
      :title="toggleLabel" :aria-expanded="expanded" :aria-controls="panelId" @click="toggleSearch">
      <svg v-if="!expanded" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
      <span v-if="active && !expanded" class="floating-search-indicator" aria-hidden="true"></span>
    </button>
  </div>
  </Teleport>
</template>
