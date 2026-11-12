<script setup lang="ts">
import { t } from '../../i18n';

defineProps<{ busy: boolean; canSave: boolean }>();
</script>

<template>
  <div class="integration-actions">
    <button class="primary" type="submit" :disabled="busy || !canSave">
      {{ busy ? t('sourceActions.testing') : t('sourceActions.save') }}
    </button>
  </div>
</template>
