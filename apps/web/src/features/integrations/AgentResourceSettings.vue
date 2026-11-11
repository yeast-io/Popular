<script setup lang="ts">
import { useI18n } from '../../i18n';
import { useAgentResources } from './agent-resource.composable';
import IntegrationDefaultAction from './IntegrationDefaultAction.vue';

const { t } = useI18n();
const { mode, devices, selectedDevice, loading, loaded, busy, error, enabled, load, toggle } = useAgentResources();
import { agentResourceNames as names } from './agent-resource.presentation';
</script>
<template>
  <section class="agent-resource-settings">
    <header>
      <div>
        <h3>{{ t('agentResources.title') }}</h3>
        <p>{{ t('agentResources.description') }}</p>
      </div>
      <button
        type="button"
        role="switch"
        class="agent-mode-switch"
        :aria-checked="enabled"
        :aria-label="t('agentResources.title')"
        :disabled="loading || busy || !loaded || (!enabled && !selectedDevice)"
        @click="toggle"
      >
        <span class="agent-mode-track" aria-hidden="true"><span /></span
        >{{ t(enabled ? 'agentResources.on' : 'agentResources.off') }}
      </button>
    </header>
    <p v-if="loading" role="status">{{ t('agentResources.loading') }}</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <label v-if="loaded && !enabled && devices.length" class="agent-device-choice"
      >{{ t('agentResources.device')
      }}<select v-model="selectedDevice" :disabled="busy">
        <option v-for="device in devices" :key="device.id" :value="device.id">
          {{ device.id }}{{ device.isAgentOnline ? '' : ` · ${t('agentResources.offline')}` }}
        </option>
      </select></label
    >
    <p v-if="loaded && !devices.length && !enabled">{{ t('agentResources.noDevice') }}</p>
    <template v-if="enabled">
      <p class="agent-mode-note">{{ t('agentResources.localNotice') }}</p>
      <p v-if="mode.unavailable" role="status" class="error">{{ t('agentResources.unavailable') }}</p>
      <ul v-if="mode.sites?.length" class="agent-site-statuses">
        <li v-for="site in mode.sites" :key="site.site">
          <div>
            <strong>{{ names[site.site] }}</strong
            ><span>{{
              t(
                !site.enabled
                  ? 'agentResources.siteDisabled'
                  : site.status === 'configured_valid'
                    ? 'agentResources.siteReady'
                    : 'agentResources.siteInvalid',
              )
            }}</span>
          </div>
          <IntegrationDefaultAction
            category="resource"
            :id="site.site"
            :status="site.enabled ? site.status : 'unconfigured'"
          />
        </li>
      </ul>
    </template>
    <button type="button" class="agent-refresh" :disabled="loading || busy" @click="load">
      {{ t('agentResources.refresh') }}
    </button>
  </section>
  <slot v-if="loaded" :agent-enabled="enabled" />
</template>
<style scoped>
.agent-resource-settings {
  padding: 24px;
  border: 1px solid var(--border-color, #dfe4e8);
  border-radius: 14px;
  background: var(--surface-color, transparent);
}
header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 20px;
}
h3 {
  margin: 0 0 8px;
}
p {
  line-height: 1.6;
  opacity: 0.8;
  font-size: 13px;
}
.agent-mode-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  border: 1px solid var(--border-color, #dfe4e8);
  border-radius: 999px;
  padding: 8px 13px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.agent-mode-track {
  width: 30px;
  height: 18px;
  border-radius: 999px;
  background: #9aaba1;
  padding: 3px;
  display: flex;
}
.agent-mode-track > span {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: white;
}
[aria-checked='true'] .agent-mode-track {
  background: #428268;
  justify-content: flex-end;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.agent-device-choice {
  display: grid;
  gap: 8px;
  font-size: 13px;
  margin: 16px 0;
}
select {
  max-width: 100%;
  padding: 9px;
}
.agent-site-statuses {
  padding: 0;
  list-style: none;
}
.agent-site-statuses li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-color, #dfe4e8);
  gap: 12px;
}
.agent-site-statuses li > div {
  display: grid;
  gap: 5px;
  font-size: 12px;
}
.agent-mode-note {
  border-left: 3px solid #428268;
  padding-left: 12px;
}
.error {
  color: #b4443c;
}
.agent-refresh {
  font-size: 12px;
  background: transparent;
  color: inherit;
  border: 1px solid var(--border-color, #dfe4e8);
  border-radius: 7px;
  padding: 7px 12px;
}
@media (max-width: 600px) {
  header {
    flex-direction: column;
  }
  .agent-resource-settings {
    padding: 18px;
  }
}
</style>
