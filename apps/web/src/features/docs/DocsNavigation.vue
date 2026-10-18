<script setup lang="ts">
import type { DocsNode } from './docs-tree';
defineProps<{ nodes: DocsNode[]; selected: string }>();
defineEmits<{ select: [path: string] }>();
</script>
<template>
  <ul class="docs-tree">
    <li v-for="node in nodes" :key="node.path">
      <button v-if="node.document" type="button" :class="{ active: selected === node.path }" :aria-current="selected === node.path ? 'page' : undefined" @click="$emit('select', node.path)">{{ node.document.title }}</button>
      <details v-else open>
        <summary>{{ node.name }}</summary>
        <DocsNavigation :nodes="node.children" :selected="selected" @select="$emit('select', $event)" />
      </details>
    </li>
  </ul>
</template>
<style scoped>
.docs-tree { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.docs-tree .docs-tree { margin: 6px 0 8px 10px; padding-left: 10px; border-left: 1px solid #ffffff15; }
.docs-tree button { width: 100%; border: 1px solid transparent; border-radius: 7px; padding: 10px 12px; background: transparent; color: #a8aaa3; font: inherit; font-size: .8rem; line-height: 1.5; text-align: left; overflow-wrap: anywhere; cursor: pointer; }
.docs-tree button:hover { background: #ffffff08; color: #ededdf; }
.docs-tree button.active { border-color: #e45a3133; background: #e45a3112; color: #f3b09a; }
.docs-tree summary { padding: 10px 8px; color: #c6c8bf; font-size: .75rem; cursor: pointer; overflow-wrap: anywhere; }
.docs-tree button:focus-visible, .docs-tree summary:focus-visible { outline: 2px solid #ef795f; outline-offset: 2px; }
</style>
