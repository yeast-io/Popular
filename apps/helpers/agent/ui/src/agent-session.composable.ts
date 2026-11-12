import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import messages from './locales/messages.json';
import {
  defaultPort,
  parseDownloaderAddress,
  downloaderAddressUrl,
} from './features/downloaders/downloader-address.domain';
import { useDownloaderProfiles } from './features/downloaders/downloader-profiles.composable';
import { useResourceSites } from './features/resource-sites/resource-sites.composable';
import { useAgentRuntime } from './agent-runtime.composable';
import type { DownloaderAddress, Locale, SecretChange, Settings, Snapshot } from './settings.types';
import type { AgentClient, AgentHost, AgentPage, DownloaderRequest } from './transport/agent-transport.types';

export function useAgentSession(client: AgentClient, host: AgentHost) {
  const sites = useResourceSites(client.resourceSites);
  const form = reactive<Settings>({
    locale: navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US',
    gatewayUrl: '',
    provider: 'qbittorrent',
    downloaderUrl: 'http://127.0.0.1:8080',
    username: '',
    authMode: 'password',
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
  watch(
    address,
    () => {
      form.downloaderUrl = downloaderAddressUrl(address, form.provider);
    },
    { flush: 'sync' }
  );
  watch(
    () => form.provider,
    (provider, previous) => {
      if (provider === 'transmission') form.authMode = 'password';
      if (address.port === defaultPort(previous)) address.port = defaultPort(provider);
      if (provider === 'qbittorrent' && address.host.endsWith('/transmission/rpc')) {
        address.host = address.host.slice(0, -17);
      }
      form.downloaderUrl = downloaderAddressUrl(address, provider);
    },
    { flush: 'sync' }
  );
  const hasApiKey = ref(false);
  const hasPassword = ref(false);
  const apiKey = ref('');
  const password = ref('');
  watch(
    () => form.authMode,
    () => {
      password.value = '';
    },
    { flush: 'sync' }
  );
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
  const savedAuthMode = ref<Settings['authMode']>('password');
  const savedProvider = ref<Settings['provider']>('qbittorrent');
  const editingGateway = ref(false);
  const editingDownloader = ref(false);
  const confirmReset = ref(false);
  const { runtime, runtimeFailed, lastRuntimeAt, refreshRuntime } = useAgentRuntime(client);
  const page = ref<AgentPage>('overview');
  const loadError = ref(false);
  const savingLocale = ref(false);
  let active = true;
  let initializeId = 0;
  let stopNavigation: (() => void) | undefined;
  let localeSave = Promise.resolve();
  const t = computed(() => messages[form.locale]);
  function text(key: string): string {
    return (t.value as Record<string, string>)[key] ?? t.value.unknownError;
  }
  function errorCode(cause: unknown): string {
    return typeof cause === 'string' && cause in t.value ? cause : 'unknownError';
  }
  function chooseLocale(locale: Locale) {
    if (loaded.value && !busy.value) form.locale = locale;
  }
  function navigate(next: AgentPage) {
    page.value = next;
  }
  async function openDocumentation(event: MouseEvent, provider: Settings['provider']) {
    event.preventDefault();
    documentationError.value = false;
    try {
      await host.openDocumentation(provider);
    } catch {
      if (active) documentationError.value = true;
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
    return JSON.stringify([settings.provider, address, settings.username, settings.authMode]);
  }
  const gatewayChanged = computed(() => endpoint(form.gatewayUrl) !== endpoint(savedGateway.value));
  const downloaderChanged = computed(() => downloaderTarget(form) !== savedDownloader.value || Boolean(password.value));
  const gatewayPending = computed(
    () => form.gatewayEnabled && (runtime.value.service === 'connecting' || runtime.value.binding === 'binding')
  );
  const canConnect = computed(
    () =>
      !busy.value
      && loaded.value
      && !gatewayPending.value
      && Boolean(form.gatewayUrl.trim())
      && (Boolean(apiKey.value) || (hasApiKey.value && !gatewayChanged.value))
      && (runtime.value.service !== 'online' || gatewayChanged.value || Boolean(apiKey.value))
  );
  const downloaderStatus = computed(() =>
    runtimeFailed.value
      ? 'statusUnknown'
      : !lastRuntimeAt.value
          ? 'checkingStatus'
          : form.downloaderConfigured
            ? runtime.value.downloader
            : 'unconfigured'
  );
  const gatewayConfigured = computed(() => Boolean(savedGateway.value && hasApiKey.value));
  const showGatewayForm = computed(() => !gatewayConfigured.value || editingGateway.value);
  const showDownloaderForm = computed(() => !form.downloaderConfigured || editingDownloader.value);
  const canDisconnect = computed(
    () =>
      ['online', 'connecting'].includes(runtime.value.service)
      || (form.gatewayEnabled
        && gatewayConfigured.value
        && !['unconfigured', 'rebindRequired', 'bindingFailed', 'unbound', 'legacyIdentity', 'sessionRevoked'].includes(
          runtime.value.service
        ))
  );
  const hasGatewayChanges = computed(() => gatewayChanged.value || Boolean(apiKey.value));
  const passwordSaved = computed(() => hasPassword.value && downloaderTarget(form) === savedDownloader.value);
  const connectLabel = computed(() => (gatewayPending.value ? 'connecting' : 'connect'));

  async function connect() {
    if (!canConnect.value) return;
    busy.value = true;
    gatewayError.value = '';
    try {
      const snapshot = await client.connectGateway({
        gatewayUrl: form.gatewayUrl,
        locale: form.locale,
        apiKey: secretChange(apiKey.value),
      });
      if (!active) return;
      // Keep the other section's draft and password untouched.
      form.gatewayUrl = snapshot.settings.gatewayUrl;
      savedGateway.value = snapshot.settings.gatewayUrl;
      form.gatewayEnabled = snapshot.settings.gatewayEnabled;
      editingGateway.value = false;
      hasApiKey.value = snapshot.hasApiKey;
      apiKey.value = '';
      if (active) await refreshRuntime(true);
    } catch (cause) {
      if (active) gatewayError.value = errorCode(cause);
    } finally {
      busy.value = false;
    }
  }
  function applyDownloaderSnapshot(snapshot: Snapshot) {
    form.provider = snapshot.settings.provider;
    form.authMode = snapshot.settings.authMode;
    form.downloaderUrl = snapshot.settings.downloaderUrl;
    loadAddress(snapshot.settings.downloaderUrl || 'http://127.0.0.1:8080');
    form.username = snapshot.settings.username;
    hasPassword.value = snapshot.hasPassword;
    savedDownloader.value = downloaderTarget(snapshot.settings);
    savedDownloaderUrl.value = snapshot.settings.downloaderUrl;
    savedProvider.value = snapshot.settings.provider;
    savedAuthMode.value = snapshot.settings.authMode;
    savedUsername.value = snapshot.settings.username;
    form.downloaderConfigured = snapshot.settings.downloaderConfigured;
    editingDownloader.value = false;
    password.value = '';
  }
  const profiles = useDownloaderProfiles(client.downloaderProfiles, applyDownloaderSnapshot);
  async function connectDownloader() {
    if (busy.value || !loaded.value) return;
    busy.value = true;
    downloaderError.value = '';
    commitAddress();
    const request: DownloaderRequest = {
      provider: form.provider,
      downloaderUrl: downloaderAddressUrl(address, form.provider),
      username: form.username,
      authMode: form.authMode,
      // A new target with a blank password uses no password; never forward the old target's secret.
      password:
        !password.value && downloaderTarget(form) !== savedDownloader.value
          ? { action: 'clear' }
          : secretChange(password.value),
    };
    try {
      const snapshot = await client.testDownloader(request);
      if (!active) return;
      applyDownloaderSnapshot(snapshot);
      if (active) await refreshRuntime(true);
    } catch (cause) {
      if (active) downloaderError.value = errorCode(cause);
    } finally {
      busy.value = false;
    }
  }
  async function disconnect() {
    if (busy.value) return;
    busy.value = true;
    gatewayError.value = '';
    try {
      await client.disconnectGateway();
      if (!active) return;
      form.gatewayEnabled = false;
      runtime.value.service = 'manuallyDisconnected';
      if (active) await refreshRuntime(true);
    } catch (cause) {
      if (active) gatewayError.value = errorCode(cause);
    } finally {
      busy.value = false;
    }
  }
  async function resetDownloader() {
    if (busy.value) return;
    busy.value = true;
    downloaderError.value = '';
    try {
      const snapshot = await client.resetDownloader();
      if (!active) return;
      form.downloaderConfigured = false;
      form.provider = snapshot.settings.provider;
      form.authMode = snapshot.settings.authMode;
      form.username = '';
      loadAddress('http://127.0.0.1:8080');
      savedDownloader.value = downloaderTarget(snapshot.settings);
      savedDownloaderUrl.value = '';
      savedProvider.value = snapshot.settings.provider;
      savedAuthMode.value = snapshot.settings.authMode;
      savedUsername.value = snapshot.settings.username;
      password.value = '';
      hasPassword.value = false;
      confirmReset.value = false;
      editingDownloader.value = false;
      runtime.value.downloader = 'unconfigured';
    } catch (cause) {
      if (active) downloaderError.value = errorCode(cause);
    } finally {
      busy.value = false;
    }
  }
  function closeDownloaderEditor() {
    form.provider = savedProvider.value;
    form.authMode = savedAuthMode.value;
    loadAddress(savedDownloaderUrl.value || 'http://127.0.0.1:8080');
    form.username = savedUsername.value;
    password.value = '';
    editingDownloader.value = false;
  }
  function closeGatewayEditor() {
    form.gatewayUrl = savedGateway.value;
    apiKey.value = '';
    editingGateway.value = false;
  }

  const dirtyGateway = computed(() => loaded.value && (gatewayChanged.value || !!apiKey.value));
  const dirtyDownloader = computed(() => loaded.value && (downloaderChanged.value || profiles.dirty.value));
  const dirtySites = sites.dirty;
  const dirty = computed(() => dirtyGateway.value || dirtyDownloader.value || dirtySites.value);
  async function initialize() {
    if (busy.value && initializeId > 0) return;
    const id = ++initializeId;
    busy.value = true;
    loadError.value = false;
    settingsError.value = '';
    try {
      const snapshot = await client.loadSettings();
      if (!active || id !== initializeId) return;
      Object.assign(form, snapshot.settings);
      loadAddress(snapshot.settings.downloaderUrl || 'http://127.0.0.1:8080');
      savedGateway.value = snapshot.settings.gatewayUrl;
      form.gatewayEnabled = snapshot.settings.gatewayEnabled;
      editingGateway.value = false;
      savedDownloader.value = downloaderTarget(snapshot.settings);
      savedDownloaderUrl.value = snapshot.settings.downloaderUrl;
      savedProvider.value = snapshot.settings.provider;
      savedAuthMode.value = snapshot.settings.authMode;
      savedUsername.value = snapshot.settings.username;
      form.downloaderConfigured = snapshot.settings.downloaderConfigured;
      editingDownloader.value = false;
      hasApiKey.value = snapshot.hasApiKey;
      hasPassword.value = snapshot.hasPassword;
      loaded.value = true;
    } catch (cause) {
      if (active && id === initializeId) {
        loadError.value = true;
        settingsError.value = errorCode(cause);
      }
    } finally {
      if (active && id === initializeId) busy.value = false;
    }
  }
  async function signOut() {
    if (!host.signOut || busy.value) return;
    busy.value = true;
    settingsError.value = '';
    try {
      await host.signOut();
    } catch (cause) {
      if (active) settingsError.value = errorCode(cause);
    } finally {
      if (active) busy.value = false;
    }
  }
  async function setAutostart(enabled: boolean) {
    if (!host.setAutostart || busy.value || !loaded.value) return;
    busy.value = true;
    settingsError.value = '';
    try {
      await host.setAutostart(enabled);
      if (active) {
        form.autostart = enabled;
        await refreshRuntime(true);
      }
    } catch (cause) {
      if (active) settingsError.value = errorCode(cause);
    } finally {
      if (active) busy.value = false;
    }
  }
  watch(
    [() => runtime.value.autostart, busy],
    ([value, working]) => {
      if (!working && value !== undefined) form.autostart = value;
    },
    { flush: 'sync' }
  );
  watch(
    () => form.locale,
    (locale, previous) => {
      document.documentElement.lang = locale;
      document.title = messages[locale].productName;
      void host.setTitle?.(messages[locale].productName).catch(() => {});
      if (!loaded.value || locale === previous) return;
      savingLocale.value = true;
      localeSave = localeSave.then(async () => {
        if (!active) return;
        try {
          await client.saveLocale(locale);
        } catch (cause) {
          if (active && form.locale === locale) settingsError.value = errorCode(cause);
        } finally {
          if (active && form.locale === locale) savingLocale.value = false;
        }
      });
    },
    { immediate: true, flush: 'sync' }
  );
  function beforeUnload(event: BeforeUnloadEvent) {
    if (dirty.value) {
      event.preventDefault();
      event.returnValue = '';
    }
  }
  onMounted(() => {
    window.addEventListener('beforeunload', beforeUnload);
    void initialize();
    if (host.onNavigate)
      void host
        .onNavigate(navigate)
        .then((stop) => {
          if (active) stopNavigation = stop;
          else stop();
        })
        .catch(() => {
          if (active) settingsError.value = 'runtimeError';
        });
  });
  onBeforeUnmount(() => {
    active = false;
    ++initializeId;
    stopNavigation?.();
    window.removeEventListener('beforeunload', beforeUnload);
    apiKey.value = '';
    password.value = '';
  });
  return {
    client,
    sites,
    profiles,
    host,
    form,
    address,
    t,
    text,
    page,
    navigate,
    runtime,
    runtimeFailed,
    lastRuntimeAt,
    refreshRuntime,
    loaded,
    busy,
    loadError,
    initialize,
    settingsError,
    documentationError,
    openDocumentation,
    hasApiKey,
    hasPassword,
    apiKey,
    password,
    gatewayError,
    downloaderError,
    savedGateway,
    savedDownloaderUrl,
    savedProvider,
    editingGateway,
    editingDownloader,
    confirmReset,
    gatewayChanged,
    gatewayPending,
    canConnect,
    downloaderChanged,
    downloaderStatus,
    gatewayConfigured,
    showGatewayForm,
    showDownloaderForm,
    canDisconnect,
    hasGatewayChanges,
    passwordSaved,
    connectLabel,
    connect,
    connectDownloader,
    disconnect,
    resetDownloader,
    closeDownloaderEditor,
    closeGatewayEditor,
    commitAddress,
    chooseLocale,
    savingLocale,
    setAutostart,
    signOut,
    dirty,
    dirtySites,
    dirtyGateway,
    dirtyDownloader,
  };
}
