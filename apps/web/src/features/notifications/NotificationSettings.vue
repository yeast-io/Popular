<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { NotificationPreferences, SaveNotificationPreferences } from '@movie-hub/contract';
import { loadWebConfig } from '../../config/env';
import { t } from '../../i18n';
import { localizedErrorMessage, localizedResponseError } from '../../i18n/api-error';
const { apiBaseUrl } = loadWebConfig();
const draft = ref<SaveNotificationPreferences>({ enabled: false, defaultChannel: 'whatsapp', additionalChannels: [] });
const channels = ref<NotificationPreferences['channels']>([]);
const loading = ref(true);
const initialized = ref(false);
const busy = ref(false);
const error = ref('');
const saved = ref(false);
let disposed = false;
const controller = new AbortController();
const unavailable = computed(() => draft.value.enabled && [draft.value.defaultChannel, ...draft.value.additionalChannels].some(id => !channels.value.find(channel => channel.id === id)?.configured));
async function request(method = 'GET') {
  const response = await fetch(`${apiBaseUrl}/me/notifications`, { method, credentials: 'include', signal: controller.signal,
    ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft.value) } : {}) });
  if (!response.ok) throw await localizedResponseError(response);
  return await response.json() as NotificationPreferences;
}
async function refresh(availabilityOnly = true) {
  try {
    const result = await request();
    if (disposed) return;
    channels.value = result.channels;
    if (!availabilityOnly) initialized.value = true;
    if (!availabilityOnly) draft.value = { enabled: result.enabled, defaultChannel: result.defaultChannel, additionalChannels: result.additionalChannels };
  } catch (cause) { if (!disposed) error.value = localizedErrorMessage(cause, 'errors.requestFailed'); }
  finally { if (!disposed && !availabilityOnly) loading.value = false; }
}
async function save() {
  if (busy.value || loading.value || !initialized.value || unavailable.value) return;
  busy.value = true; error.value = ''; saved.value = false;
  try {
    const result = await request('PUT');
    if (disposed) return;
    draft.value = { enabled: result.enabled, defaultChannel: result.defaultChannel, additionalChannels: result.additionalChannels };
    channels.value = result.channels; saved.value = true;
  } catch (cause) { if (!disposed) error.value = localizedErrorMessage(cause, 'errors.requestFailed'); }
  finally { if (!disposed) busy.value = false; }
}
function selectDefault() { draft.value.additionalChannels = draft.value.additionalChannels.filter(id => id !== draft.value.defaultChannel); saved.value = false; }
defineExpose({ refresh });
onMounted(() => { void refresh(false); });
onUnmounted(() => { disposed = true; controller.abort(); });
</script>
<template>
  <section class="settings-card notification-preferences" :aria-busy="loading || busy" aria-labelledby="notification-title">
    <header class="notification-heading"><h3 id="notification-title">{{ t('notifications.title') }}</h3><p>{{ t('notifications.description') }}</p></header>
    <p v-if="loading" role="status">{{ t('notifications.loading') }}</p>
    <form v-else class="notification-form" @submit.prevent="save" @change="saved = false">
      <label class="notification-switch"><span class="notification-switch-copy">{{ t('notifications.enabled') }}</span><input v-model="draft.enabled" type="checkbox" role="switch" :disabled="busy" /></label>
      <p class="notification-hint">{{ t('notifications.disableHint') }}</p>
      <div class="notification-channel-field">
      <label id="notification-default-label" :for="channels.length > 1 ? 'notification-default' : undefined">{{ t('notifications.default') }}</label>
      <select v-if="channels.length > 1" id="notification-default" v-model="draft.defaultChannel" :disabled="busy" @change="selectDefault">
        <option v-for="channel in channels" :key="channel.id" :value="channel.id">{{ channel.name }}</option>
      </select>
      <div v-else-if="channels[0]" id="notification-default" role="group" aria-labelledby="notification-default-label" class="notification-channel">
        <span class="notification-channel-icon" aria-hidden="true">{{ channels[0].id === 'whatsapp' ? 'WA' : channels[0].name.slice(0, 2).toUpperCase() }}</span>
        <strong>{{ channels[0].name }}</strong>
        <span class="notification-channel-status" :class="{ linked: channels[0].configured }"><i aria-hidden="true"></i>{{ t(channels[0].configured ? 'notifications.linked' : 'notifications.unlinked') }}</span>
      </div>
      </div>
      <fieldset v-if="channels.length > 1" :disabled="busy" class="notification-extras">
        <legend>{{ t('notifications.additional') }}</legend>
        <label v-for="channel in channels.filter(item => item.id !== draft.defaultChannel)" :key="channel.id">
          <input v-model="draft.additionalChannels" type="checkbox" :value="channel.id" /> {{ channel.name }}
        </label>
      </fieldset>
      <p v-if="unavailable" class="error" role="alert">{{ t('notifications.linkFirst') }}</p>
      <div class="notification-footer">
        <div class="notification-feedback"><p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="saved" class="success" role="status">{{ t('notifications.saved') }}</p></div>
        <button type="submit" class="primary" :disabled="busy || !initialized || unavailable">{{ busy ? t('notifications.saving') : t('notifications.save') }}</button>
      </div>
    </form>
  </section>
</template>
<style scoped>
.notification-preferences { min-width: 0; }
.notification-heading { display: block; margin: 0 0 24px; }
.notification-heading h3 { margin: 0 0 8px; font-family: inherit; font-size: .95rem; font-weight: 600; }
.notification-heading p { max-width: 72ch; margin: 0; color: #92968e; font-size: .78rem; line-height: 1.65; }
.notification-form { display: grid; gap: 0; min-width: 0; }
.notification-switch { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 0; color: #d8dbd2; font-size: .82rem; font-weight: 600; cursor: pointer; }
.notification-preferences .notification-switch input { appearance: none; box-sizing: border-box; flex: 0 0 42px; width: 42px; min-width: 42px; max-width: 42px; height: 24px; min-height: 24px; max-height: 24px; margin: 0; padding: 0; border: 1px solid #555a54; border-radius: 24px; background: #373c36; cursor: pointer; position: relative; transition: background .15s; }
.notification-preferences .notification-switch input::after { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; border-radius: 50%; background: #d5dad1; transition: transform .15s; }
.notification-preferences .notification-switch input:checked { background: #cb4c31; border-color: #dd6b50; }
.notification-preferences .notification-switch input:checked::after { transform: translateX(18px); background: white; }
.notification-preferences .notification-switch input:focus-visible { outline: 2px solid #ef9c86; outline-offset: 3px; box-shadow: none; }
.notification-hint { max-width: 76ch; margin: 10px 0 24px; color: #858b80; font-size: .74rem; line-height: 1.7; }
.notification-channel-field { display: grid; gap: 10px; }
.notification-channel-field > label { color: #b9c0b3; font-size: .75rem; font-weight: 500; }
.notification-channel { display: flex; align-items: center; gap: 10px; width: min(100%, 420px); min-height: 52px; padding: 10px 12px; border: 1px solid #ffffff15; border-radius: 8px; background: #11151380; }
.notification-channel-icon { display: grid; place-items: center; flex: 0 0 28px; height: 28px; border-radius: 7px; background: #29493670; color: #a6d8b3; font-size: .65rem; font-weight: 600; }
.notification-channel strong { font-size: .8rem; font-weight: 500; }
.notification-channel-status { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; color: #979d91; font-size: .68rem; white-space: nowrap; }
.notification-channel-status i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.notification-channel-status.linked { color: #96c6a2; }
.notification-preferences select { width: min(100%, 420px); min-height: 42px; padding: 10px 12px; border: 1px solid #3a3f37; border-radius: 7px; background: #111513; color: #eee; font: inherit; font-size: .8rem; }
.notification-extras { min-width: 0; margin: 20px 0 0; border: 0; padding: 0; display: grid; gap: 12px; }
.notification-extras legend { margin-bottom: 12px; color: #b9c0b3; font-size: .75rem; }
.notification-extras label { display: flex; align-items: center; gap: 10px; font-size: .78rem; }
.notification-preferences .notification-extras input { flex: 0 0 16px; width: 16px; min-height: 16px; height: 16px; margin: 0; padding: 0; accent-color: #dd6b50; }
.notification-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 24px; padding-top: 18px; border-top: 1px solid #ffffff12; }
.notification-feedback { flex: 1; min-width: 0; font-size: .75rem; }
.notification-feedback p { margin: 0; }
.notification-preferences .notification-footer button { flex-shrink: 0; width: auto; min-height: 36px; margin: 0; padding: 9px 15px; border-radius: 7px; font-size: .75rem; font-weight: 600; }
@media (max-width: 600px) {
  .notification-heading { margin-bottom: 20px; }
  .notification-footer { flex-wrap: wrap; }
  .notification-footer button { margin-left: auto; }
}
</style>
