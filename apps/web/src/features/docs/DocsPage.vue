<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { DocsDocument, DocsEntry, DocsIndex } from '@movie-hub/contract';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import DocsNavigation from './DocsNavigation.vue';
import MarkdownContent from './MarkdownContent.vue';
import { buildDocsTree } from './docs-tree';

const { apiBaseUrl } = loadWebConfig();
const { t } = useI18n();
const entries = ref<DocsEntry[]>([]);
const tree = computed(() => buildDocsTree(entries.value));
const selected = ref('');
const document = ref<DocsDocument | null>(null);
const loading = ref(true);
const error = ref('');
const mobile = window.matchMedia('(max-width: 760px)');
const sidebarOpen = ref(!mobile.matches);
function syncSidebar() {
  sidebarOpen.value = !mobile.matches;
}
let sequence = 0;
let stopped = false;
let request: AbortController | undefined;
const indexRequest = new AbortController();
async function select(path: string, hash = '', history = true) {
  const id = ++sequence;
  request?.abort();
  request = new AbortController();
  selected.value = path;
  loading.value = true;
  error.value = '';
  document.value = null;
  if (mobile.matches) sidebarOpen.value = false;
  if (history) {
    const url = `/docs?path=${encodeURIComponent(path)}${hash}`;
    window.history.pushState(window.history.state, '', url);
  }
  try {
    const response = await fetch(`${apiBaseUrl}/docs/content?path=${encodeURIComponent(path)}`, {
      credentials: 'include',
      signal: request.signal,
    });
    if (!response.ok) throw new Error(t('docs.failed'));
    const result = (await response.json()) as DocsDocument;
    if (stopped || id !== sequence) return;
    document.value = result;
    await nextTick();
    if (hash) window.document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  } catch (cause) {
    if (!stopped && id === sequence) error.value = cause instanceof Error ? cause.message : t('docs.failed');
  } finally {
    if (!stopped && id === sequence) loading.value = false;
  }
}
function syncLocation() {
  if (window.location.pathname !== '/docs' || !entries.value.length) return;
  const path = new URLSearchParams(window.location.search).get('path') ?? entries.value[0]!.path;
  void select(path, window.location.hash, false);
}
async function load() {
  error.value = '';
  loading.value = true;
  try {
    const response = await fetch(`${apiBaseUrl}/docs`, { credentials: 'include', signal: indexRequest.signal });
    if (!response.ok) throw new Error(t('docs.failed'));
    const result = (await response.json()) as DocsIndex;
    if (stopped) return;
    entries.value = result.items;
    if (entries.value.length) {
      const path = new URLSearchParams(window.location.search).get('path') ?? entries.value[0]!.path;
      await select(path, window.location.hash, false);
    }
  } catch {
    if (!stopped) error.value = t('docs.failed');
  } finally {
    if (!stopped) loading.value = false;
  }
}
onMounted(() => {
  window.addEventListener('popstate', syncLocation);
  mobile.addEventListener?.('change', syncSidebar);
  void load();
});
onBeforeUnmount(() => {
  stopped = true;
  sequence++;
  request?.abort();
  indexRequest.abort();
  window.removeEventListener('popstate', syncLocation);
  mobile.removeEventListener?.('change', syncSidebar);
});
</script>
<template>
  <main class="docs-page">
    <header class="docs-heading">
      <h1>{{ t('nav.docs') }}</h1>
    </header>
    <div class="docs-layout">
      <details
        class="docs-sidebar"
        :open="sidebarOpen"
        @toggle="sidebarOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary>{{ t('docs.contents') }}</summary>
        <nav :aria-label="t('docs.contents')">
          <DocsNavigation :nodes="tree" :selected="selected" @select="select" />
        </nav>
      </details>
      <article class="docs-article" :aria-busy="loading">
        <p v-if="loading" role="status" class="docs-message">{{ t('docs.loading') }}</p>
        <div v-else-if="error" role="alert" class="docs-message">
          <p>{{ error }}</p>
          <button class="secondary" type="button" @click="load">{{ t('docs.retry') }}</button>
        </div>
        <p v-else-if="!entries.length" class="docs-message">{{ t('docs.empty') }}</p>
        <MarkdownContent v-else-if="document" :markdown="document.markdown" :path="document.path" @navigate="select" />
      </article>
    </div>
  </main>
</template>
<style scoped>
.docs-page {
  width: min(1400px, 100%);
  margin: 0 auto;
  padding: 36px 32px 80px;
  box-sizing: border-box;
}
.docs-heading {
  margin-bottom: 28px;
}
.docs-heading h1 {
  margin: 0;
  font-size: 1.6rem;
  font-weight: 600;
}
.docs-layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 32px;
  align-items: start;
}
.docs-sidebar {
  position: sticky;
  top: 100px;
  max-height: calc(100dvh - 120px);
  overflow-y: auto;
  padding-right: 16px;
  border-right: 1px solid #ffffff12;
}
.docs-sidebar > summary {
  margin: 0 0 16px;
  color: #8f9589;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
}
.docs-article {
  min-width: 0;
  min-height: 300px;
  padding: 28px 32px;
  border: 1px solid #ffffff12;
  border-radius: 12px;
  background: #16191ae6;
}
.docs-message {
  color: #a0a598;
  font-size: 0.85rem;
  line-height: 1.7;
}
.docs-message button {
  width: auto;
  margin: 12px 0 0;
  padding: 8px 16px;
  font-size: 0.78rem;
}
@media (max-width: 760px) {
  .docs-page {
    padding: 24px 16px 48px;
  }
  .docs-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .docs-sidebar {
    position: static;
    max-height: 280px;
    padding: 12px;
    border: 1px solid #ffffff12;
    border-radius: 8px;
    background: #16191a;
  }
  .docs-sidebar > summary {
    margin: 0;
  }
  .docs-sidebar[open] > summary {
    margin-bottom: 12px;
  }
  .docs-article {
    padding: 24px 18px;
  }
}
</style>
