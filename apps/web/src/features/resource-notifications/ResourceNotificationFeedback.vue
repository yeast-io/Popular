<script setup lang="ts">
import { useI18n } from '../../i18n';
import type { ResourceNotificationFeedback } from './resource-notification.types';

defineProps<{ feedback: ResourceNotificationFeedback | null }>();
const { t } = useI18n();
</script>

<template>
  <p v-if="feedback" class="resource-notification-feedback" role="alert">
    {{ feedback.message }}
    <a v-if="feedback.needsChannel" href="/settings?section=messages">{{ t('resourceNotifications.configure') }}</a>
  </p>
</template>

<style scoped>
.resource-notification-feedback { margin: 12px 0 0; max-width: 100%; color: #df8b80; font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
.resource-notification-feedback a { margin-inline-start: 6px; color: var(--brand); text-decoration: underline; text-underline-offset: 3px; }
</style>
