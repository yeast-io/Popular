<script setup lang="ts">
import type { IntegrationCategory, IntegrationPreferences } from '@movie-hub/contract';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadWebConfig } from '../../config/env';
import { useI18n } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';
import { agentResourceNames } from './agent-resource.presentation';

const props = defineProps<{
  id: string;
  category: IntegrationCategory;
  status: string;
  disabled?: boolean | undefined;
}>();
const siteName = computed(() => {
  if (Object.hasOwn(agentResourceNames, props.id)) return agentResourceNames[props.id as keyof typeof agentResourceNames];
  return props.id;
});
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
  <div class="integration-default-action" :class="{ 'resource-site-controls': category === 'resource' }">
    <span v-if="category !== 'resource' && isDefault" class="integration-default-badge">{{ t('integrationDefaults.default') }}</span>
    <button
      v-else-if="category !== 'resource'"
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
      class="site-enable-toggle"
      :aria-label="
        t('resourceSelection.enableSite', {
          name: siteName,
        })
      "
      :aria-checked="preferences?.effectiveSites?.includes(id) ?? false"
      :title="t(isDefault ? 'resourceSelection.defaultRequired' : 'resourceSelection.hint')"
      :disabled="busy || disabled || !preferences || isDefault || status === 'unconfigured'"
      @click="toggleResourceSite"
    >
      <span class="site-enable-track" aria-hidden="true"><span /></span>
      <span>{{
        t(preferences?.effectiveSites?.includes(id) ? 'resourceSelection.enabled' : 'resourceSelection.disabled')
      }}</span>
    </button>
    <span v-if="category === 'resource'" class="site-control-divider" aria-hidden="true" />
    <label v-if="category === 'resource'" class="integration-default-choice">
      <input
        type="radio"
        name="default-resource-site"
        :value="id"
        :checked="isDefault"
        :disabled="busy || disabled || status !== 'configured_valid' || !preferences"
        @change="setDefault"
      />
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m10 2 2.4 4.9 5.4.8-3.9 3.8.9 5.4L10 14.3l-4.8 2.6.9-5.4L2.2 7.7l5.4-.8Z" />
      </svg>
      <span>{{ t(isDefault ? 'integrationDefaults.default' : 'integrationDefaults.setDefault') }}</span>
    </label>
    <span v-if="error" class="error" role="alert">{{ error }}</span>
  </div>
</template>

<style scoped>
/* Site control treatment informed by unslop by @heydamir, CC BY 4.0. */
.resource-site-controls {
  --control-border: #444742;
  --control-text: #aeb3ba;
  --control-accent: #f58165;
  --control-tint: #34231d;
  --control-off: #545b52;
  --control-hover: #282b27;
  flex-wrap: nowrap;
  gap: 16px;
}

.site-enable-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--control-text);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}
.site-enable-toggle:hover:not(:disabled) {
  background: transparent;
  color: inherit;
}
.site-enable-toggle:disabled {
  opacity: 1;
  cursor: default;
}
.site-enable-track {
  display: inline-flex;
  align-items: center;
  flex: 0 0 36px;
  width: 36px;
  height: 22px;
  padding: 2px;
  border-radius: 12px;
  background: var(--control-off);
  transition: background-color 150ms ease;
}
.site-enable-track > span {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px #0002;
  transition: transform 150ms ease;
}
.site-enable-toggle[aria-checked='true'] .site-enable-track {
  background: #e54c2a;
}
.site-enable-toggle[aria-checked='true'] .site-enable-track > span {
  transform: translateX(14px);
}
.site-control-divider {
  width: 1px;
  height: 20px;
  background: var(--control-border);
}
.integration-default-choice {
  position: relative;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 96px;
  min-height: 36px;
  margin: 0;
  padding: 6px 10px;
  border: 1px solid var(--control-border);
  border-radius: 8px;
  background: transparent;
  color: var(--control-text);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}
.integration-default-choice input[type='radio'] {
  position: absolute;
  width: 1px;
  height: 1px;
  min-height: 0;
  margin: 0;
  padding: 0;
  opacity: 0;
}
.integration-default-choice svg {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;
}
.integration-default-choice:hover:not(:has(input:disabled)) {
  background: var(--control-hover);
}
.integration-default-choice:has(input:checked) {
  border-color: transparent;
  color: var(--control-accent);
  background: var(--control-tint);
}
.integration-default-choice:has(input:checked) svg {
  fill: currentColor;
}
.integration-default-choice:has(input:disabled) {
  opacity: 0.4;
  cursor: default;
}
.integration-default-choice:focus-within,
.site-enable-toggle:focus-visible {
  outline: 2px solid var(--control-accent);
  outline-offset: 4px;
  border-radius: 8px;
}
@media (prefers-reduced-motion: reduce) {
  .site-enable-track,
  .site-enable-track > span {
    transition: none;
  }
}
</style>
