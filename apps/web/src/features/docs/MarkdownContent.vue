<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import DOMPurify from 'dompurify';
import { useI18n } from '../../i18n';
import { renderMarkdown } from './markdown';

const props = defineProps<{ markdown: string; path: string }>();
const emit = defineEmits<{ navigate: [path: string, hash: string] }>();
const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const html = computed(() => renderMarkdown(props.markdown, props.path));
let sequence = 0;
let diagramId = 0;
function followLink(event: MouseEvent) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const link = (event.target as Element).closest<HTMLAnchorElement>('a[data-doc-path]');
  if (!link?.dataset.docPath) return;
  event.preventDefault();
  emit('navigate', link.dataset.docPath, link.hash);
}
watch(
  html,
  async () => {
    const id = ++sequence;
    await nextTick();
    const blocks = root.value?.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
    if (!blocks?.length) return;
    let mermaid: (typeof import('mermaid'))['default'];
    try {
      ({ default: mermaid } = await import('mermaid'));
    } catch {
      if (id !== sequence) return;
      const message = document.createElement('p');
      message.className = 'docs-diagram-error';
      message.textContent = t('docs.diagramError');
      root.value?.append(message);
      return;
    }
    if (id !== sequence) return;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      suppressErrorRendering: true,
      htmlLabels: false,
    }
    );
    for (const block of blocks) {
      if (id !== sequence) return;
      try {
        const { svg } = await mermaid.render(`docs-diagram-${++diagramId}`, block.textContent ?? '');
        if (id !== sequence || !block.isConnected) return;
        const diagram = document.createElement('div');
        diagram.className = 'docs-diagram';
        diagram.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        block.parentElement?.replaceWith(diagram);
      } catch {
        if (id !== sequence) return;
        const message = document.createElement('p');
        message.className = 'docs-diagram-error';
        message.textContent = t('docs.diagramError');
        block.parentElement?.after(message);
      }
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  sequence++;
});
</script>
<template><div ref="root" class="docs-markdown" @click="followLink" v-html="html"></div></template>
<style scoped>
.docs-markdown {
  color: #c5c8bf;
  font-size: 0.9rem;
  line-height: 1.85;
  overflow-wrap: anywhere;
}
.docs-markdown :deep(:is(h1, h2, h3, h4, h5, h6)) {
  color: #efefe9;
  line-height: 1.4;
  scroll-margin-top: 110px;
}
.docs-markdown :deep(h1) {
  margin: 0 0 28px;
  font-size: 1.8rem;
  letter-spacing: -0.03em;
}
.docs-markdown :deep(h2) {
  margin: 36px 0 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ffffff12;
  font-size: 1.25rem;
}
.docs-markdown :deep(h3) {
  margin: 28px 0 12px;
  font-size: 1rem;
}
.docs-markdown :deep(p) {
  margin: 14px 0;
}
.docs-markdown :deep(a) {
  color: #f39b81;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
.docs-markdown :deep(pre) {
  margin: 20px 0;
  padding: 18px;
  overflow-x: auto;
  border: 1px solid #ffffff12;
  border-radius: 8px;
  background: #0e1112;
  font-size: 0.78rem;
  line-height: 1.7;
}
.docs-markdown :deep(code) {
  border-radius: 4px;
  padding: 2px 5px;
  background: #ffffff0a;
  color: #ded5c1;
  font-size: 0.85em;
}
.docs-markdown :deep(pre code) {
  padding: 0;
  background: transparent;
  font-size: inherit;
}
.docs-markdown :deep(blockquote) {
  margin: 20px 0;
  padding: 2px 20px;
  border-left: 3px solid #b9654c;
  color: #a8ada0;
}
.docs-markdown :deep(table) {
  display: block;
  max-width: 100%;
  margin: 20px 0;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.docs-markdown :deep(th),
.docs-markdown :deep(td) {
  border: 1px solid #ffffff18;
  padding: 10px 14px;
  text-align: left;
}
.docs-markdown :deep(th) {
  background: #ffffff06;
  color: #e1e3d9;
}
.docs-markdown :deep(img) {
  max-width: 100%;
}
.docs-markdown :deep(.docs-diagram) {
  margin: 24px 0;
  padding: 12px;
  overflow-x: auto;
  border: 1px solid #ffffff12;
  border-radius: 8px;
  background: #111516;
}
.docs-markdown :deep(.docs-diagram svg) {
  display: block;
  margin: auto;
  max-width: 100%;
  height: auto;
}
.docs-markdown :deep(.docs-diagram-error) {
  color: #e59b84;
  font-size: 0.75rem;
}
</style>
