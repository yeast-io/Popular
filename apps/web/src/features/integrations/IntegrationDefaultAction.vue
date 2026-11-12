<script setup lang="ts">
import type { IntegrationCategory, IntegrationPreferences } from '@movie-hub/contract';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';

const props = defineProps<{
  id: string;
  category: IntegrationCategory;
  status: string;
  disabled?: boolean | undefined;
}>();
const { apiBaseUrl } = loadWebConfig();
const { t, locale } = useI18n();
const preferences = ref<IntegrationPreferences | null>(null);
const busy = ref(false);
const error = ref('');
const isDefault = computed(() => preferences.value?.defaults?.[props.category] === props.id);
async function load() {
  try {
    const response = await fetch(`${apiBaseUrl}/me/integration-preferences`, { credentials: 'include' });
    if (!response.ok) throw await localizedResponseError(response);
    preferences.value = await response.json();
    error.value = '';
  } catch (cause) {
    error.value = localizedErrorMessage(cause, 'errors.requestFailed');
  }
}
async function setDefault() {
  busy.value = true;
  error.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integration-preferences/default`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'accept-language': locale.value },
      body: JSON.stringify({ category: props.category, id: props.id }),
    });
    if (!response.ok) throw await localizedResponseError(response);
    preferences.value = await response.json();
    window.dispatchEvent(new Event('integration-preferences-changed'));
  } catch (cause) {
    error.value = localizedErrorMessage(cause, 'errors.requestFailed');
  } finally {
    busy.value = false;
  }
}
async function toggleResourceSite() {
  if (!preferences.value || busy.value || props.disabled || isDefault.value || props.status === 'unconfigured') return;
  const sites = preferences.value.effectiveSites ?? [];
  busy.value = true;
  error.value = '';
  try {
    const response = await fetch(`${apiBaseUrl}/me/integration-preferences/resource-sites`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'accept-language': locale.value },
      body: JSON.stringify({
        sites: sites.includes(props.id) ? sites.filter((id) => id !== props.id) : [...sites, props.id],
      }),
    });
    if (!response.ok) throw await localizedResponseError(response);
    preferences.value = await response.json();
    window.dispatchEvent(new Event('integration-preferences-changed'));
  } catch (cause) {
    error.value = localizedErrorMessage(cause, 'errors.requestFailed');
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void load();
  window.addEventListener('integration-preferences-changed', load);
});
onBeforeUnmount(() => window.removeEventListener('integration-preferences-changed', load));
watch(
  () => props.status,
  () => window.dispatchEvent(new Event('integration-preferences-changed'))
);
</script>
<template>
  <div class="integration-default-action">
    <label v-if="category === 'resource'" class="integration-default-choice">
      <input
        type="radio"
        name="default-resource-site"
        :value="id"
        :checked="isDefault"
        :disabled="busy || disabled || status !== 'configured_valid' || !preferences"
        @change="setDefault"
      />
      {{ t('integrationDefaults.default') }}
    </label>
    <span v-else-if="isDefault" class="integration-default-badge">{{ t('integrationDefaults.default') }}</span>
    <button
      v-else
      type="button"
      class="integration-default-badge integration-default-button"
      :disabled="busy || disabled || status !== 'configured_valid' || !preferences"
      @click="setDefault"
    >
      {{ t('integrationDefaults.setDefault') }}
    </button>
    <button
      v-if="category === 'resource'"
      type="button"
      role="switch"
      class="resource-site-switch"
      :aria-label="
        t('resourceSelection.enableSite', {
          name: id === 'mteam' ? 'M-Team' : id === 'hdarea' ? 'HDArea' : id === 'hdwing' ? 'HDWing' : id,
        })
      "
      :aria-checked="preferences?.effectiveSites?.includes(id) ?? false"
      :title="t(isDefault ? 'resourceSelection.defaultRequired' : 'resourceSelection.hint')"
      :disabled="busy || disabled || !preferences || isDefault || status === 'unconfigured'"
      @click="toggleResourceSite"
    >
      <span class="resource-site-switch-track" aria-hidden="true"><span /></span>
      <span>{{
        t(preferences?.effectiveSites?.includes(id) ? 'resourceSelection.enabled' : 'resourceSelection.disabled')
      }}</span>
    </button>
    <span v-if="error" class="error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
.integration-default-choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: #aeb3ba;
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}
.integration-default-choice input[type="radio"] {
  width: 14px;
  height: 14px;
  min-height: 0;
  flex: 0 0 14px;
  margin: 0;
  padding: 0;
  border-radius: 50%;
  box-shadow: none;
  accent-color: #367a56;
}
.resource-site-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border: 0;
  background: none;
  color: #aeb3ba;
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
}
.resource-site-switch-track {
  display: inline-flex;
  align-items: center;
  width: 36px;
  height: 21px;
  padding: 3px;
  border-radius: 999px;
  background: #444849;
  transition: background 0.15s;
}
.resource-site-switch-track > span {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #e2e0d9;
  transition: transform 0.15s;
}
.resource-site-switch[aria-checked='true'] .resource-site-switch-track {
  background: #367a56;
}
.resource-site-switch[aria-checked='true'] .resource-site-switch-track > span {
  transform: translateX(15px);
}
.resource-site-switch:disabled {
  cursor: default;
  opacity: 0.65;
}
.resource-site-switch:focus-visible {
  outline: 2px solid #8bd6a8;
  outline-offset: 4px;
  border-radius: 4px;
}
</style>
