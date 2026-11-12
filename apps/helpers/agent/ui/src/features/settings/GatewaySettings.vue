<script setup lang="ts">
import { useAgentContext } from '../../agent-context.composable';
import SecretInput from '../../components/SecretInput.vue';

const {
  form,
  t,
  text,
  runtime,
  runtimeFailed,
  lastRuntimeAt,
  busy,
  loaded,
  apiKey,
  hasApiKey,
  gatewayFailure,
  savedGateway,
  editingGateway,
  gatewayChanged,
  canConnect,
  gatewayConfigured,
  showGatewayForm,
  canDisconnect,
  hasGatewayChanges,
  connectLabel,
  connect,
  disconnect,
  closeGatewayEditor,
} = useAgentContext();
</script>
<template>
  <form novalidate @submit.prevent="connect">
    <fieldset :disabled="busy || !loaded">
      <legend>{{ t.gateway }}</legend>
      <div class="card-summary">
        <div class="summary-details">
          <p class="connection-status" role="status">
            <span
              :class="[
                'status-dot',
                {
                  online: !runtimeFailed && runtime.service === 'online',
                  failed: form.gatewayEnabled && runtime.service === 'disconnected',
                },
              ]"
            />{{ text(runtimeFailed ? 'statusUnknown' : !lastRuntimeAt ? 'checkingStatus' : runtime.service)
            }}<span v-if="runtime.binding === 'bound'" class="binding-state">{{ t.bound }}</span>
          </p>
          <p v-if="savedGateway" class="saved-address">{{ savedGateway }}</p>
        </div>
        <div v-if="gatewayConfigured && !showGatewayForm" class="summary-actions">
          <button type="button" class="quiet" @click="editingGateway = true">{{ t.editConfig }}</button>
          <button v-if="canDisconnect" type="button" @click="disconnect">{{ t.disconnect }}</button>
          <button v-else type="submit" class="primary" :disabled="!canConnect">{{ text(connectLabel) }}</button>
        </div>
      </div>
      <template v-if="showGatewayForm">
        <label
          >{{ t.gatewayUrl
          }}<input
            v-model="form.gatewayUrl"
            type="url"
            maxlength="2048"
            placeholder="https://gateway.example"
            autocapitalize="off"
            spellcheck="false"
        /></label>
        <p class="hint">{{ t.gatewayHint }}</p>
        <label
          >{{ t.apiKey
          }}<SecretInput
            v-model="apiKey"
            :saved="hasApiKey && !gatewayChanged"
            :placeholder="hasApiKey && !gatewayChanged ? t.keepSecret : t.newApiKey"
        /></label>
      </template>
      <div v-if="showGatewayForm" class="section-actions">
        <button v-if="canDisconnect" type="button" @click="disconnect">{{ t.disconnect }}</button>
        <button v-else type="submit" class="primary" :disabled="!canConnect">{{ text(connectLabel) }}</button>
        <button
          v-if="canDisconnect && editingGateway && hasGatewayChanges"
          type="submit"
          class="primary"
          :disabled="!canConnect"
        >
          {{ t.applyAndConnect }}
        </button>
        <button v-if="editingGateway" type="button" class="quiet" @click="closeGatewayEditor">{{ t.cancel }}</button>
      </div>
      <p v-if="gatewayFailure" class="error" role="alert">{{ text(gatewayFailure) }}</p>
    </fieldset>
  </form>
</template>
