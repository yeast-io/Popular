<script setup lang="ts">
import { computed } from 'vue';
import { useAgentContext } from '../agent-context.composable';

const props = defineProps<{ status: string }>();
const { t, text } = useAgentContext();
const label = computed(() =>
  ['gatewayProtocol', 'legacyIdentity', 'deviceLimitReached', 'sessionRevoked'].includes(props.status)
    ? text(`${props.status}Status`)
    : text(props.status)
);
const tone = computed(() =>
  props.status === 'online'
    ? 'positive'
    : ['disconnected', 'unreachable', 'bindingFailed', 'rebindRequired', 'sessionRevoked'].includes(props.status)
        ? 'warning'
        : 'neutral'
);
</script>
<template>
  <span class="pill" :class="tone" role="status"
    ><span class="status-dot" :class="{ online: status === 'online' }" />{{
      status === 'bound' ? t.bound : label
    }}</span
  >
</template>
