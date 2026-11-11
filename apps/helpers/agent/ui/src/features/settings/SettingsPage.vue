<script setup lang="ts">
import { useAgentContext } from '../../agent-context.composable';
import GatewaySettings from './GatewaySettings.vue';

const {
  t,
  form,
  runtime,
  host,
  loaded,
  busy,
  savingLocale,
  chooseLocale,
  setAutostart,
  lastRuntimeAt,
  refreshRuntime,
} = useAgentContext();
function changeAutostart(event: Event) {
  const input = event.target as HTMLInputElement;
  const requested = input.checked;
  input.checked = form.autostart;
  void setAutostart(requested);
}
</script>
<template>
  <GatewaySettings />
  <section class="settings-panel">
    <h2>{{ t.preferences }}</h2>
    <div class="preference-row">
      <div>
        <label for="settings-language">{{ t.language }}</label>
        <p>{{ t.languageDescription }}</p>
      </div>
      <select
        id="settings-language"
        :value="form.locale"
        :disabled="busy || !loaded || savingLocale"
        @change="chooseLocale(($event.target as HTMLSelectElement).value as typeof form.locale)"
      >
        <option value="zh-CN">{{ t.chineseLanguage }}</option>
        <option value="en-US">{{ t.englishLanguage }}</option>
      </select>
    </div>
    <div v-if="host.setAutostart" class="preference-row">
      <div>
        <label for="agent-autostart">{{ t.autostart }}</label>
        <p>{{ t.autostartDescription }}</p>
      </div>
      <input
        id="agent-autostart"
        type="checkbox"
        role="switch"
        :checked="form.autostart"
        :disabled="busy || !loaded"
        @change="changeAutostart"
      />
    </div>
  </section>
  <section class="settings-panel">
    <div class="panel-heading">
      <h2>{{ t.diagnostics }}</h2>
      <button type="button" class="quiet" @click="refreshRuntime()">{{ t.refreshStatus }}</button>
    </div>
    <dl class="diagnostic-list">
      <div>
        <dt>{{ t.deviceIdentity }}</dt>
        <dd>
          <code>{{ runtime.deviceId || t.notBoundYet }}</code>
        </dd>
      </div>
      <div>
        <dt>{{ t.lastChecked }}</dt>
        <dd>
          {{
            lastRuntimeAt
              ? new Intl.DateTimeFormat(form.locale, { dateStyle: 'medium', timeStyle: 'short' }).format(lastRuntimeAt)
              : t.notChecked
          }}
        </dd>
      </div>
      <div>
        <dt>{{ t.version }}</dt>
        <dd>{{ host.version }}</dd>
      </div>
    </dl>
  </section>
</template>
