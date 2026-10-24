<script setup lang="ts">
import type { TvSeasonSummary } from '@movie-hub/contract';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from '../../i18n';

const props = defineProps<{ seasons: TvSeasonSummary[]; modelValue: number | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: number] }>();
const { t } = useI18n();
const container = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const expanded = ref(false);
const activeIndex = ref(0);
const listId = useId();
const sorted = computed(() => [...props.seasons].sort((a, b) => {
  if (a.seasonNumber === 0) return 1;
  if (b.seasonNumber === 0) return -1;
  return a.seasonNumber - b.seasonNumber;
}));
const selected = computed(() => sorted.value.find((season) => season.seasonNumber === props.modelValue));
const activeOptionId = computed(() => expanded.value && sorted.value[activeIndex.value] ? `${listId}-${sorted.value[activeIndex.value]!.seasonNumber}` : undefined);
function seasonName(season: TvSeasonSummary) {
  return season.seasonNumber === 0 ? t('tv.specials') : t('tv.seasonNumber', { number: season.seasonNumber });
}
function episodeCount(season: TvSeasonSummary) {
  return season.episodeCount === undefined ? t('tv.countUnknown') : t('tv.episodeCount', { count: season.episodeCount });
}
function revealActive() {
  void nextTick(() => {
    if (expanded.value && activeOptionId.value) document.getElementById(activeOptionId.value)?.scrollIntoView?.({ block: 'nearest' });
  });
}
function open() {
  if (!sorted.value.length) return;
  activeIndex.value = Math.max(0, sorted.value.findIndex((season) => season.seasonNumber === props.modelValue));
  expanded.value = true;
  revealActive();
}
function select(season: TvSeasonSummary) {
  emit('update:modelValue', season.seasonNumber);
  expanded.value = false;
  trigger.value?.focus({ preventScroll: true });
}
function handleKey(event: KeyboardEvent) {
  if (event.key === 'Tab') {
    expanded.value = false;
    return;
  }
  if (event.key === 'Escape') {
    if (expanded.value) {
      event.preventDefault();
      event.stopPropagation();
      expanded.value = false;
    }
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  if (!sorted.value.length) return;
  if (event.key === 'Enter' || event.key === ' ') {
    const active = sorted.value[activeIndex.value];
    if (expanded.value && active) select(active);
    else open();
    return;
  }
  const wasExpanded = expanded.value;
  if (!wasExpanded) open();
  if (event.key === 'Home') activeIndex.value = 0;
  else if (event.key === 'End') activeIndex.value = sorted.value.length - 1;
  else if (wasExpanded) activeIndex.value = (activeIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + sorted.value.length) % sorted.value.length;
  revealActive();
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !container.value?.contains(event.target)) expanded.value = false;
}
function focusOut(event: FocusEvent) {
  if (!(event.relatedTarget instanceof Node) || !container.value?.contains(event.relatedTarget)) expanded.value = false;
}
watch([() => props.modelValue, () => props.seasons], () => {
  expanded.value = false;
});
onMounted(() => document.addEventListener('pointerdown', outside));
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
</script>

<template>
  <div ref="container" class="tv-season-selector" @focusout="focusOut">
    <button ref="trigger" class="tv-season-trigger" type="button" role="combobox" :aria-label="t('tv.chooseSeason')"
      aria-haspopup="listbox" :aria-expanded="expanded" :aria-controls="listId" :aria-activedescendant="activeOptionId"
      :disabled="!sorted.length" @click="expanded ? expanded = false : open()" @keydown="handleKey">
      <span>{{ selected ? seasonName(selected) : t('tv.unknown') }}</span>
      <small v-if="selected">{{ episodeCount(selected) }}</small>
      <svg class="tv-season-chevron" :class="{ expanded }" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <div v-if="expanded" :id="listId" class="tv-season-options" role="listbox" :aria-label="t('tv.chooseSeason')">
      <div v-for="(season, index) in sorted" :id="`${listId}-${season.seasonNumber}`" :key="season.seasonNumber" role="option"
        class="tv-season-option" :class="{ selected: modelValue === season.seasonNumber, highlighted: activeIndex === index }"
        :aria-selected="modelValue === season.seasonNumber" :data-season="season.seasonNumber"
        @mouseenter="activeIndex = index" @mousedown.prevent @click="select(season)">
        <span>{{ seasonName(season) }}</span><small>{{ episodeCount(season) }}</small>
        <svg v-if="modelValue === season.seasonNumber" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
      </div>
    </div>
  </div>
</template>
