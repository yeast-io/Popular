<script setup lang="ts" generic="T extends ResourceSiteRelease">
import type { ResourceSiteRelease } from '@movie-hub/contract';
import { computed, watch } from 'vue';
import { useI18n } from '../../i18n';
import { resourceReleaseTags } from './resource-release-tags.presentation';

const props = defineProps<{ releases: T[]; loading?: boolean }>();
const { t } = useI18n();
const selected = defineModel<string[]>('selected', { default: () => [] });
const tagged = computed(() => props.releases.map((release) => ({ release, tags: resourceReleaseTags(release) })));
const options = computed(() => [...new Map(tagged.value.flatMap(({ tags }) => tags.map((label) => [label.toLowerCase(), label] as const))).entries()]);
const filtered = computed(() => tagged.value.filter(({ tags }) => {
  const keys = tags.map((tag) => tag.toLowerCase());
  return selected.value.every((key) => keys.includes(key));
}).map(({ release }) => release));
watch(options, (available) => {
  const keys = new Set(available.map(([key]) => key));
  const retained = selected.value.filter((key) => keys.has(key));
  if (retained.length !== selected.value.length) selected.value = retained;
});
function toggle(key: string) {
  selected.value = selected.value.includes(key) ? selected.value.filter((tag) => tag !== key) : [...selected.value, key];
}
</script>

<template>
  <div v-if="options.length" class="release-tag-filters" role="group" :aria-label="t('resourceFilters.label')">
    <button v-for="[key, label] in options" :key="key" class="release-tag-filter" type="button"
      :aria-pressed="selected.includes(key)" @click="toggle(key)">
      {{ label === 'chinese-subtitles' ? t('movie.releases.tags.chineseSubtitles') : label }}
    </button>
    <p class="release-filter-hint">{{ t('resourceFilters.hint') }}</p>
    <p v-if="selected.length" class="release-filter-count" role="status">{{ t('resourceFilters.count', { count: filtered.length, total: releases.length }) }}</p>
  </div>
  <p v-if="selected.length && !filtered.length && !loading" class="muted-copy" role="status">{{ t('resourceFilters.empty') }}</p>
  <slot :releases="filtered" />
</template>

<style scoped>
.release-tag-filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.release-tag-filter { border: 1px solid #414243; border-radius: 999px; padding: 5px 14px; color: #aaa; background: transparent; font: inherit; font-size: .78rem; cursor: pointer; overflow-wrap: anywhere; max-width: 100%; }
.release-tag-filter:hover { border-color: #aaa; color: #e2e0d9; }
.release-tag-filter[aria-pressed="true"] { border-color: #f5ba2b; color: #f5ba2b; background: rgba(245, 186, 43, .1); }
.release-tag-filter:focus-visible { outline: 2px solid #f5ba2b; outline-offset: 3px; }
.release-filter-hint { display: flex; align-items: center; gap: 12px; text-align: center; }
.release-filter-hint::before, .release-filter-hint::after { content: ''; flex: 1; min-width: 16px; border-top: 1px solid #414243; }
.release-filter-hint, .release-filter-count { flex-basis: 100%; margin: 0; color: #a7aaa4; font-size: .75rem; line-height: 1.5; }
</style>
