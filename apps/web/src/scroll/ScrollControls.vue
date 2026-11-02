<script setup lang="ts">
import { useI18n } from '../i18n';
import type { ScrollControlsProps } from './page-scroll.types';

const props = defineProps<ScrollControlsProps>();
const { t } = useI18n();
const { atTop, atBottom, scrollToEdge } = props.scroll;
</script>

<template>
  <nav
    v-if="enabled && (!atTop || !atBottom)"
    class="scroll-controls"
    :aria-label="t('a11y.pageNavigation')"
  >
    <button v-if="!atTop" type="button" :aria-label="t('actions.toTop')" @click="scrollToEdge('top')">
      <span aria-hidden="true">↑</span><span>{{ t('actions.top') }}</span>
    </button>
    <button v-if="!atBottom" type="button" :aria-label="t('actions.toBottom')" @click="scrollToEdge('bottom')">
      <span aria-hidden="true">↓</span><span>{{ t('actions.bottom') }}</span>
    </button>
  </nav>
</template>
