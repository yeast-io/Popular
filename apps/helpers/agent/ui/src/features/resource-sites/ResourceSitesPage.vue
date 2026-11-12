<script setup lang="ts">
import { onMounted } from 'vue';
import { useAgentContext } from '../../agent-context.composable';
import AgentIcon from '../../components/AgentIcon.vue';
import SecretInput from '../../components/SecretInput.vue';
import { resourceSitePreviews, siteNames, hdareaApiAddress } from './resource-sites.presentation';
import { canConfigureSite, sameSiteEndpoint } from './resource-sites.domain';

const { t, text, sites, form } = useAgentContext();
const { entries, loading, loaded, error, available, load, configure, toggle, setDefault, canSetDefault } = sites;
onMounted(() => {
  if (available && !loaded.value && !error.value) void load();
});
</script>
<template>
  <template v-if="!available">
    <section class="empty-feature">
      <span class="empty-feature-icon"><AgentIcon name="resource-sites" /></span>
      <h2>{{ t.sitesNotAvailableTitle }}</h2>
      <p>{{ t.sitesNotAvailableDescription }}</p>
    </section>
    <div class="site-preview-grid">
      <article v-for="site in resourceSitePreviews" :key="site" class="site-preview">
        <span class="site-initial">{{ site.slice(0, 1) }}</span>
        <div>
          <h3>{{ site }}</h3>
          <p>{{ t.noSiteCredentials }}</p>
        </div>
      </article>
    </div>
  </template>
  <template v-else>
    <p class="notice local-sites-scope" role="note">{{ t.localSitesScope }}</p>
    <p v-if="loading" role="status">{{ t.loadingSettings }}</p>
    <section v-if="error" class="load-failure" role="alert">
      <p>{{ text(error) }}</p>
      <button type="button" :disabled="loading" @click="load">{{ t.retry }}</button>
    </section>
    <div class="local-sites-grid" :aria-busy="loading">
      <article
        v-for="entry in entries"
        :key="entry.snapshot.site"
        class="local-site-card"
        :data-site="entry.snapshot.site"
      >
        <header class="local-site-header">
          <div class="local-site-identity">
            <span class="site-initial">{{ siteNames[entry.snapshot.site].slice(0, 1) }}</span>
            <div>
              <h2>{{ siteNames[entry.snapshot.site] }}</h2>
              <p>{{ t.localCredentials }}</p>
            </div>
          </div>
          <div v-if="entry.snapshot.status !== 'unconfigured'" class="local-site-controls">
            <button
              type="button"
              class="site-enable-toggle"
              role="switch"
              :aria-checked="entry.snapshot.enabled"
              :aria-label="`${siteNames[entry.snapshot.site]}: ${entry.snapshot.enabled ? t.siteEnabled : t.siteDisabled}`"
              :disabled="entry.busy || (!entry.snapshot.enabled && entry.snapshot.status === 'configured_invalid')"
              @click="toggle(entry)"
            >
              <span class="site-enable-track" aria-hidden="true"><span /></span>
              <span>{{ entry.snapshot.enabled ? t.siteEnabled : t.siteDisabled }}</span>
            </button>
            <span v-if="canSetDefault" class="site-control-divider" aria-hidden="true" />
            <label v-if="canSetDefault" class="site-default-choice">
              <input
                type="radio"
                name="default-resource-site"
                :value="entry.snapshot.site"
                :checked="entry.snapshot.isDefault"
                :disabled="entry.busy || !entry.snapshot.enabled || entry.snapshot.status !== 'configured_valid'"
                @change="setDefault(entry)"
              />
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="m10 2 2.4 4.9 5.4.8-3.9 3.8.9 5.4L10 14.3l-4.8 2.6.9-5.4L2.2 7.7l5.4-.8Z" />
              </svg>
              <span>{{ entry.snapshot.isDefault ? t.defaultItem : t.setDefault }}</span>
            </label>
          </div>
        </header>
        <span class="pill" :class="entry.snapshot.status === 'configured_invalid' ? 'warning' : 'neutral'">
          <span
            class="status-dot"
            :class="{
              online: entry.snapshot.status === 'configured_valid' && entry.snapshot.enabled,
              failed: entry.snapshot.status === 'configured_invalid',
              unconfigured: entry.snapshot.status === 'unconfigured',
            }"
          />{{
            entry.snapshot.status === 'unconfigured'
              ? t.unconfigured
              : entry.snapshot.status === 'configured_invalid'
                ? t.siteInvalid
                : t.siteConfigured
          }}</span
        >
        <p v-if="entry.error" class="error" role="alert">{{ text(entry.error) }}</p>
        <p v-else-if="entry.snapshot.lastError" class="error" role="status">{{ text(entry.snapshot.lastError) }}</p>
        <form novalidate @submit.prevent="configure(entry)">
          <label v-if="entry.snapshot.site === 'hdarea'" :for="`${entry.snapshot.site}-api-url`">
            {{ t.siteApiAddress }}
            <input
              :id="`${entry.snapshot.site}-api-url`"
              :value="hdareaApiAddress(entry.baseUrl)"
              type="url"
              readonly
              autocomplete="url"
            />
          </label>
          <label :for="`${entry.snapshot.site}-base-url`">
            {{ entry.snapshot.site === 'mteam' ? t.siteApiAddress : t.siteWebAddress }}
            <input
              :id="`${entry.snapshot.site}-base-url`"
              v-model="entry.baseUrl"
              type="url"
              maxlength="2048"
              :disabled="entry.busy"
              required
              autocomplete="url"
            />
          </label>
          <p class="field-note">{{ t.siteEndpointHint }}</p>
          <label
            >{{ entry.snapshot.site !== 'hdwing' ? t.siteApiKey : t.siteCookie
            }}<SecretInput
              :id="`${entry.snapshot.site}-${entry.snapshot.site === 'hdwing' ? 'cookie' : 'api-key'}`"
              v-model="entry.credential"
              :saved="sameSiteEndpoint(entry) && entry.snapshot.hasCredential"
              :maxlength="entry.snapshot.site === 'hdarea' ? 32 : entry.snapshot.site === 'mteam' ? 4096 : 8192"
              :disabled="entry.busy"
          /></label>

          <p v-if="entry.snapshot.site === 'hdarea'" class="field-note">{{ t.hdareaApiKeyHint }}</p>
          <p v-if="entry.snapshot.verifiedAt" class="field-note">
            {{ t.siteVerifiedAt }}: {{ new Date(entry.snapshot.verifiedAt).toLocaleString(form.locale) }}
          </p>
          <div class="site-form-footer">
            <p v-if="entry.saved" class="success" role="status" aria-live="polite">{{ t.siteSaved }}</p>
            <button class="primary" type="submit" :disabled="!canConfigureSite(entry)">
              {{ entry.busy ? t.siteTesting : t.siteVerifySave }}
            </button>
          </div>
        </form>
      </article>
    </div>
  </template>
</template>

<style scoped>
/* Site control treatment informed by unslop by @heydamir, CC BY 4.0. */
.local-site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px 24px;
}
.local-site-controls {
  --control-border: var(--border);
  --control-text: var(--secondary);
  --control-accent: #c84224;
  --control-tint: #fff3ee;
  --control-off: #b7bcb6;
  --control-hover: var(--raised);
  flex: 0 0 auto;
  gap: 16px;
}
:global(:root[data-agent-theme='dark'] .local-site-controls) {
  --control-accent: #f58165;
  --control-tint: #34231d;
  --control-off: #545b52;
}
.site-form-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}
.site-form-footer .success {
  margin: 0 auto 0 0;
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
.site-default-choice {
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
.site-default-choice input[type='radio'] {
  position: absolute;
  width: 1px;
  height: 1px;
  min-height: 0;
  margin: 0;
  padding: 0;
  opacity: 0;
}
.site-default-choice svg {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;
}
.site-default-choice:hover:not(:has(input:disabled)) {
  background: var(--control-hover);
}
.site-default-choice:has(input:checked) {
  border-color: transparent;
  color: var(--control-accent);
  background: var(--control-tint);
}
.site-default-choice:has(input:checked) svg {
  fill: currentColor;
}
.site-default-choice:has(input:disabled) {
  opacity: 0.4;
  cursor: default;
}
.site-default-choice:focus-within,
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
@media (max-width: 600px) {
  .local-site-controls {
    width: 100%;
  }
}
</style>
