<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import messages from './locales/messages.json';
import documentation from './documentation.resources.json';
import SecretInput from './SecretInput.vue';
import applicationLogo from './assets/popular-link-agent-white-ui.png';
import darkApplicationLogo from './assets/popular-link-agent-black-ui.png';
import { defaultPort, parseDownloaderAddress, downloaderAddressUrl } from './downloader-address.domain';
import type { DownloaderAddress } from './settings.types';
import qbittorrentIcon from './assets/qbittorrent.svg';
import transmissionIcon from './assets/transmission.svg';
import type { Locale, SecretChange, Settings, Snapshot, RuntimeStatus } from './settings.types';

const form = reactive<Settings>({
  locale: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US',
  gatewayUrl: '',
  provider: 'qbittorrent',
  downloaderUrl: 'http://127.0.0.1:8080',
  username: '',
  autostart: true,
  gatewayEnabled: true,
  downloaderConfigured: false,
});
const address = reactive<DownloaderAddress>({ protocol: 'http', host: '127.0.0.1', port: '8080' });
function loadAddress(url: string) {
  try {
    Object.assign(address, parseDownloaderAddress(url, form.provider));
  } catch {
    address.host = url;
  }
}
function commitAddress() {
  if (address.host.includes('://')) loadAddress(address.host);
}
watch(address, () => {
  form.downloaderUrl = downloaderAddressUrl(address, form.provider);
}, { flush: 'sync' });
watch(() => form.provider, (provider, previous) => {
  if (address.port === defaultPort(previous)) address.port = defaultPort(provider);
  if (provider === 'qbittorrent' && address.host.endsWith('/transmission/rpc')) {
    address.host = address.host.slice(0, -17);
  }
  form.downloaderUrl = downloaderAddressUrl(address, provider);
}, { flush: 'sync' });
const localeMenu = ref<HTMLDetailsElement | null>(null);
const hasApiKey = ref(false);
const hasPassword = ref(false);
const apiKey = ref('');
const password = ref('');
const busy = ref(true);
const loaded = ref(false);
const gatewayError = ref('');
const downloaderError = ref('');
const settingsError = ref('');
const documentationError = ref(false);
const savedGateway = ref('');
const savedDownloader = ref('');
const savedDownloaderUrl = ref('');
const savedUsername = ref('');
const savedProvider = ref<Settings['provider']>('qbittorrent');
const editingGateway = ref(false);
const editingDownloader = ref(false);
const confirmReset = ref(false);
const runtime = ref<RuntimeStatus>({
  service: 'unconfigured',
  downloader: 'disconnected',
  deviceId: null,
  binding: 'unbound',
  preferenceError: null,
});
const t = computed(() => messages[form.locale]);
function text(key: string): string {
  return (t.value as Record<string, string>)[key] ?? t.value.unknownError;
}
function closeLocaleMenu() {
  if (!localeMenu.value?.open) return;
  localeMenu.value.open = false;
  localeMenu.value.querySelector('summary')?.focus();
}
function chooseLocale(locale: Locale) {
  if (busy.value || !loaded.value) return;
  form.locale = locale;
  closeLocaleMenu();
}
function guardLocaleToggle(event: Event) {
  if (busy.value || !loaded.value) event.preventDefault();
}
function closeLocaleOnOutside(event: PointerEvent) {
  if (event.target instanceof Node && !localeMenu.value?.contains(event.target)) {
    localeMenu.value?.removeAttribute('open');
  }
}
function errorCode(cause: unknown): string {
  return typeof cause === 'string' && cause in t.value ? cause : 'unknownError';
}
async function openDocumentation(event: MouseEvent, provider: Settings['provider']) {
  if (!isTauri()) return;
  event.preventDefault();
  documentationError.value = false;
  try {
    await invoke('open_documentation', { provider });
  } catch {
    documentationError.value = true;
  }
}
function secretChange(value: string): SecretChange {
  return value ? { action: 'set', value } : { action: 'keep' };
}
function endpoint(value: string) {
  return value.trim().replace(/\/$/, '');
}
function downloaderTarget(settings: Settings) {
  let address;
  try {
    address = parseDownloaderAddress(settings.downloaderUrl, settings.provider);
  } catch {
    address = settings.downloaderUrl;
  }
  return JSON.stringify([settings.provider, address, settings.username]);
}
const gatewayChanged = computed(() => endpoint(form.gatewayUrl) !== endpoint(savedGateway.value));
const downloaderChanged = computed(
  () => downloaderTarget(form) !== savedDownloader.value || Boolean(password.value)
);
const gatewayPending = computed(() => form.gatewayEnabled && (runtime.value.service === 'connecting' || runtime.value.binding === 'binding'));
const canConnect = computed(
  () =>
    !busy.value
    && loaded.value
    && !gatewayPending.value
    && Boolean(form.gatewayUrl.trim())
    && (Boolean(apiKey.value) || (hasApiKey.value && !gatewayChanged.value))
    && (runtime.value.service !== 'online' || gatewayChanged.value || Boolean(apiKey.value))
);
const downloaderStatus = computed(() => form.downloaderConfigured ? runtime.value.downloader : 'unconfigured');
const gatewayConfigured = computed(() => Boolean(savedGateway.value && hasApiKey.value));
const showGatewayForm = computed(() => !gatewayConfigured.value || editingGateway.value);
const showDownloaderForm = computed(() => !form.downloaderConfigured || editingDownloader.value);
const canDisconnect = computed(() =>
  ['online', 'connecting'].includes(runtime.value.service)
  || (form.gatewayEnabled && gatewayConfigured.value
    && !['unconfigured', 'rebindRequired', 'bindingFailed', 'unbound', 'legacyIdentity', 'sessionRevoked'].includes(runtime.value.service))
);
const hasGatewayChanges = computed(() => gatewayChanged.value || Boolean(apiKey.value));
const passwordSaved = computed(() => hasPassword.value && downloaderTarget(form) === savedDownloader.value);
const connectLabel = computed(() => (gatewayPending.value ? 'connecting' : 'connect'));

async function connect() {
  if (!canConnect.value) return;
  busy.value = true;
  gatewayError.value = '';
  try {
    const snapshot = await invoke<Snapshot>('connect_device', {
      request: {
        gatewayUrl: form.gatewayUrl,
        locale: form.locale,
        apiKey: secretChange(apiKey.value),
      },
    });
    // Keep the other section's draft and password untouched.
    form.gatewayUrl = snapshot.settings.gatewayUrl;
    savedGateway.value = snapshot.settings.gatewayUrl;
    form.gatewayEnabled = snapshot.settings.gatewayEnabled;
    editingGateway.value = false;
    hasApiKey.value = snapshot.hasApiKey;
    apiKey.value = '';
    await refreshRuntime();
  } catch (cause) {
    gatewayError.value = errorCode(cause);
  } finally {
    busy.value = false;
  }
}
async function connectDownloader() {
  if (busy.value || !loaded.value) return;
  busy.value = true;
  downloaderError.value = '';
  commitAddress();
  const request = {
    provider: form.provider,
    downloaderUrl: downloaderAddressUrl(address, form.provider),
    username: form.username,
    // A new target with a blank password uses no password; never forward the old target's secret.
    password: !password.value && downloaderTarget(form) !== savedDownloader.value
      ? { action: 'clear' }
      : secretChange(password.value),
  };
  try {
    const snapshot = await invoke<Snapshot>('test_downloader', { request });
    form.provider = snapshot.settings.provider;
    form.downloaderUrl = snapshot.settings.downloaderUrl;
    loadAddress(snapshot.settings.downloaderUrl || 'http://127.0.0.1:8080');
    form.username = snapshot.settings.username;
    hasPassword.value = snapshot.hasPassword;
    savedDownloader.value = downloaderTarget(snapshot.settings);
    savedDownloaderUrl.value = snapshot.settings.downloaderUrl;
    savedProvider.value = snapshot.settings.provider;
    savedUsername.value = snapshot.settings.username;
    form.downloaderConfigured = snapshot.settings.downloaderConfigured;
    editingDownloader.value = false;
    password.value = '';
    await refreshRuntime();
  } catch (cause) {
    downloaderError.value = errorCode(cause);
  } finally {
    busy.value = false;
  }
}
async function disconnect() {
  if (busy.value) return;
  busy.value = true;
  gatewayError.value = '';
  try {
    await invoke('disconnect_gateway');
    form.gatewayEnabled = false;
    runtime.value.service = 'manuallyDisconnected';
    await refreshRuntime();
  } catch (cause) {
    gatewayError.value = errorCode(cause);
  } finally { busy.value = false; }
}
async function resetDownloader() {
  if (busy.value) return;
  busy.value = true;
  downloaderError.value = '';
  try {
    const snapshot = await invoke<Snapshot>('reset_downloader');
    form.downloaderConfigured = false;
    form.provider = snapshot.settings.provider;
    form.username = '';
    loadAddress('http://127.0.0.1:8080');
    savedDownloader.value = downloaderTarget(snapshot.settings);
    savedDownloaderUrl.value = '';
    password.value = '';
    hasPassword.value = false;
    confirmReset.value = false;
    editingDownloader.value = false;
    runtime.value.downloader = 'unconfigured';
  } catch (cause) {
    downloaderError.value = errorCode(cause);
  } finally { busy.value = false; }
}
function closeDownloaderEditor() {
  form.provider = savedProvider.value;
  loadAddress(savedDownloaderUrl.value);
  form.username = savedUsername.value;
  password.value = '';
  editingDownloader.value = false;
}
function closeGatewayEditor() {
  form.gatewayUrl = savedGateway.value;
  apiKey.value = '';
  editingGateway.value = false;
}
watch(
  () => form.locale,
  async (locale: Locale, previous) => {
    const shouldSave = loaded.value && locale !== previous;
    const title = messages[locale].title;
    document.documentElement.lang = locale;
    document.title = title;
    try {
      await getCurrentWindow().setTitle(title);
    } catch {
      /* Browser-only preview. */
    }
    if (!shouldSave) return;
    settingsError.value = '';
    try {
      await invoke('save_locale', { locale });
    } catch (cause) {
      settingsError.value = errorCode(cause);
    }
  },
  { immediate: true }
);
let timer: ReturnType<typeof setInterval>;
let refreshing = false;
async function refreshRuntime() {
  if (refreshing) return;
  refreshing = true;
  try {
    runtime.value = await invoke<RuntimeStatus>('runtime_status');
  } catch {
    /* Settings actions surface native errors; a poll must not overwrite a form error. */
  } finally {
    refreshing = false;
  }
}
onMounted(async () => {
  document.addEventListener('pointerdown', closeLocaleOnOutside);
  try {
    const snapshot = await invoke<Snapshot>('load_settings');
    Object.assign(form, snapshot.settings);
    loadAddress(snapshot.settings.downloaderUrl || 'http://127.0.0.1:8080');
    savedGateway.value = snapshot.settings.gatewayUrl;
    form.gatewayEnabled = snapshot.settings.gatewayEnabled;
    editingGateway.value = false;
    savedDownloader.value = downloaderTarget(snapshot.settings);
    savedDownloaderUrl.value = snapshot.settings.downloaderUrl;
    savedProvider.value = snapshot.settings.provider;
    savedUsername.value = snapshot.settings.username;
    form.downloaderConfigured = snapshot.settings.downloaderConfigured;
    editingDownloader.value = false;
    hasApiKey.value = snapshot.hasApiKey;
    hasPassword.value = snapshot.hasPassword;
    loaded.value = true;
  } catch (cause) {
    settingsError.value = errorCode(cause);
  } finally {
    busy.value = false;
  }
  await refreshRuntime();
  timer = setInterval(() => {
    void refreshRuntime();
  }, 2000);
});
onUnmounted(() => {
  clearInterval(timer);
  document.removeEventListener('pointerdown', closeLocaleOnOutside);
});
</script>

<template>
  <main>
    <header>
      <div class="brand"><picture><source media="(prefers-color-scheme: dark)" :srcset="darkApplicationLogo" /><img :src="applicationLogo" alt="" /></picture><h1>{{ t.settingsTitle }}</h1></div>
      <details ref="localeMenu" class="locale-switcher" @keydown.esc.prevent="closeLocaleMenu">
        <summary :aria-label="`${t.language}: ${form.locale === 'zh-CN' ? t.chineseLanguage : t.englishLanguage}`"
          :title="t.language" :aria-disabled="busy || !loaded" @click="guardLocaleToggle">
          <svg class="locale-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9S14.4 18.5 12 21M12 3C9.6 5.5 8.4 8.5 8.4 12s1.2 6.5 3.6 9" />
          </svg>
        </summary>
        <div class="locale-options" role="group" :aria-label="t.language">
          <button type="button" :class="{ active: form.locale === 'zh-CN' }" :aria-pressed="form.locale === 'zh-CN'"
            :disabled="busy || !loaded" @click="chooseLocale('zh-CN')">{{ t.chineseLanguage }}</button>
          <button type="button" :class="{ active: form.locale === 'en-US' }" :aria-pressed="form.locale === 'en-US'"
            :disabled="busy || !loaded" @click="chooseLocale('en-US')">{{ t.englishLanguage }}</button>
        </div>
      </details>
    </header>
    <form novalidate @submit.prevent="connect">
      <fieldset :disabled="busy || !loaded">
        <legend>{{ t.gateway }}</legend>
        <div class="card-summary">
          <div class="summary-details">
            <p class="connection-status" role="status"><span :class="['status-dot', { online: runtime.service === 'online', failed: form.gatewayEnabled && runtime.service === 'disconnected' }]" />{{ text(runtime.service) }}</p>
            <p v-if="savedGateway" class="saved-address">{{ savedGateway }}</p>
          </div>
          <button v-if="gatewayConfigured && !showGatewayForm" type="button" class="quiet" @click="editingGateway = true">{{ t.editConfig }}</button>
          <span v-if="runtime.binding === 'bound'" class="binding-state">{{ t.bound }}</span>
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
        <div class="section-actions">
          <button v-if="canDisconnect" type="button" @click="disconnect">{{ t.disconnect }}</button>
          <button v-else type="submit" class="primary" :disabled="!canConnect">{{ text(connectLabel) }}</button>
          <button v-if="canDisconnect && editingGateway && hasGatewayChanges" type="submit" class="primary" :disabled="!canConnect">{{ t.applyAndConnect }}</button>
          <button v-if="editingGateway" type="button" class="quiet" @click="closeGatewayEditor">{{ t.cancel }}</button>
        </div>
        <p v-if="gatewayError" class="error" role="alert">{{ text(gatewayError) }}</p>
      </fieldset>
    </form>
    <form novalidate @submit.prevent="connectDownloader">
      <fieldset :disabled="busy || !loaded">
        <legend>{{ t.downloader }}</legend>
        <div class="card-summary">
          <div class="summary-details">
            <p class="connection-status" role="status"><span :class="['status-dot', { online: downloaderStatus === 'online', failed: downloaderStatus === 'unreachable' }]" /><template v-if="form.downloaderConfigured"><img class="tool-icon" :src="savedProvider === 'qbittorrent' ? qbittorrentIcon : transmissionIcon" alt="" />{{ savedProvider === 'qbittorrent' ? 'qBittorrent' : 'Transmission' }} · </template>{{ text(downloaderStatus) }}</p>
            <p v-if="savedDownloaderUrl" class="saved-address">{{ savedDownloaderUrl }}</p>
          </div>
          <button v-if="form.downloaderConfigured && !showDownloaderForm" type="button" class="quiet" @click="editingDownloader = true">{{ t.editConfig }}</button>
        </div>
        <template v-if="showDownloaderForm">
        <div class="provider-options" role="radiogroup" :aria-label="t.provider">
          <label class="provider-option" :class="{ selected: form.provider === 'qbittorrent' }">
            <input v-model="form.provider" type="radio" name="downloader" value="qbittorrent" />
            <img :src="qbittorrentIcon" alt="" />
            <span>qBittorrent</span>
          </label>
          <label class="provider-option" :class="{ selected: form.provider === 'transmission' }">
            <input v-model="form.provider" type="radio" name="downloader" value="transmission" />
            <img :src="transmissionIcon" alt="" />
            <span>Transmission</span>
          </label>
        </div>
        <div class="downloader-address">
          <div class="address-field">
            <label for="downloader-host">{{ t.downloaderHost }}</label>
            <div class="address-input">
              <select v-model="address.protocol" :aria-label="t.protocol">
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </select>
              <span class="protocol-divider" aria-hidden="true">://</span>
              <input id="downloader-host" v-model="address.host" required type="text" maxlength="2048"
                placeholder="127.0.0.1" autocapitalize="off" spellcheck="false" @change="commitAddress" />
            </div>
          </div>
          <label>{{ t.port }}
            <input v-model="address.port" type="text" inputmode="numeric" maxlength="5"
              :placeholder="defaultPort(form.provider)" />
          </label>
        </div>
        <p class="hint">{{ form.provider === 'qbittorrent' ? t.qbHint : t.transmissionHint }}</p>
        <div class="credentials">
          <label
            >{{ t.username
            }}<input
              v-model="form.username"
              maxlength="512"
              autocomplete="username"
              autocapitalize="off"
              spellcheck="false"
          /></label>
          <label
            >{{ t.password
            }}<SecretInput
              v-model="password"
              :saved="passwordSaved"
              :placeholder="passwordSaved ? t.keepSecret : t.newSecret"
          /></label>
        </div>
        <p v-if="hasPassword && downloaderChanged" class="hint">{{ t.targetHint }}</p>
        </template>
        <div v-if="confirmReset" class="reset-confirmation" role="alert">
          <p class="hint">{{ t.resetHint }}</p>
          <div class="section-actions"><button type="button" class="danger" @click="resetDownloader">{{ t.confirmReset }}</button><button type="button" @click="confirmReset = false">{{ t.cancel }}</button></div>
        </div>
        <div v-else class="section-actions">
          <button v-if="showDownloaderForm" type="submit" class="primary" :disabled="busy">{{ busy ? t.busy : t.connect }}</button>
          <button v-if="form.downloaderConfigured" type="button" @click="confirmReset = true">{{ t.resetConfig }}</button>
          <button v-if="editingDownloader" type="button" class="quiet" @click="closeDownloaderEditor">{{ t.cancel }}</button>
        </div>
        <p v-if="downloaderError" class="error" role="alert">{{ text(downloaderError) }}</p>
      </fieldset>
    </form>
    <aside class="connection-guide" :aria-label="t.connectionGuide">
      <h2>{{ t.connectionGuide }}</h2>
      <p>{{ t.gatewayExplanation }}</p>
      <p>{{ t.downloaderExplanation }}</p>
      <details>
        <summary>{{ t.webAccessHelp }}</summary>
        <p>{{ t.webAccessInstructions }}</p>
        <p>{{ t.webAccessDocs }}</p>
        <div class="documentation-links">
          <a :href="documentation.qbittorrent" target="_blank" rel="noopener noreferrer" @click="openDocumentation($event, 'qbittorrent')">{{ t.qbittorrentDocs }}</a>
          <a :href="documentation.transmission" target="_blank" rel="noopener noreferrer" @click="openDocumentation($event, 'transmission')">{{ t.transmissionDocs }}</a>
        </div>
        <p v-if="documentationError" class="error" role="alert">{{ t.documentationError }}</p>
      </details>
    </aside>
    <p v-if="settingsError || runtime.preferenceError" class="error" role="alert">
      {{ text(settingsError || runtime.preferenceError || 'unknownError') }}
    </p>
  </main>
</template>
