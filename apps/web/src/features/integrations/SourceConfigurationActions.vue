<script setup lang="ts">
import { t } from '../../i18n';

defineProps<{
  configured: boolean;
  busy: boolean;
  deleting?: boolean;
  confirmDelete: boolean;
  deletePrompt: string;
  canSave: boolean;
}>();
const emit = defineEmits<{ 'update:confirmDelete': [value: boolean]; 'delete': []; 'retest': [] }>();
</script>

<template>
  <div class="integration-actions">
    <div v-if="configured && confirmDelete" class="integration-delete">
      <span>{{ deletePrompt }}</span>
      <button class="secondary" type="button" :disabled="busy" @click="emit('update:confirmDelete', false)">{{ t('sourceActions.cancel') }}</button>
      <button class="secondary danger" type="button" :disabled="busy" @click="emit('delete')">{{ deleting ? t('sourceActions.deleting') : t('sourceActions.confirmDelete') }}</button>
    </div>
    <button v-else-if="configured" class="secondary danger integration-delete-trigger" type="button" :disabled="busy" @click="emit('update:confirmDelete', true)">{{ t('sourceActions.delete') }}</button>
    <button v-if="configured" class="secondary" type="button" :disabled="busy" @click="emit('retest')">{{ t('sourceActions.retest') }}</button>
    <button class="primary" type="submit" :disabled="busy || !canSave">{{ busy && !deleting ? t('sourceActions.testing') : t('sourceActions.save') }}</button>
  </div>
</template>
