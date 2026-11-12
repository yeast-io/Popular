// Explicit development entrypoint. Neither App nor the library imports this fixture.
import { createApp } from 'vue';
import AgentRoot from '../src/AgentRoot.vue';
import '../src/style.css';
import messages from '../src/locales/messages.json';
import manifest from '../package.json';
import type { AgentClient, AgentHost, AgentPage } from '../src/transport/agent-transport.types';
import type { DownloaderProfile } from '../src/features/downloaders/downloader-profiles.types';
import type { ResourceSiteSnapshot } from '../src/features/resource-sites/resource-sites.types';
import type { Snapshot, RuntimeStatus } from '../src/settings.types';

const params = new URLSearchParams(location.search);
const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
const state = params.get('state');
const configured = state !== 'setup';
const banner = document.getElementById('preview-banner');
if (banner) banner.textContent = messages[locale].previewNotice;
let settings: Snapshot = {
  settings: {
    locale,
    gatewayUrl: configured ? 'https://gateway.example' : '',
    provider: 'qbittorrent',
    downloaderUrl: 'http://192.168.1.20:8080',
    username: 'popular',
    authMode: 'password',
    autostart: true,
    gatewayEnabled: true,
    downloaderConfigured: configured,
  },
  hasApiKey: configured,
  hasPassword: configured,
};
const runtime: RuntimeStatus = {
  service: configured ? 'online' : 'unconfigured',
  downloader: configured ? 'online' : 'unconfigured',
  binding: configured ? 'bound' : 'unbound',
  deviceId: configured ? 'preview-device' : null,
  preferenceError: null,
};
let localSites: ResourceSiteSnapshot[] = (['mteam', 'hdarea', 'hdwing'] as const).map((site) => ({
  site,
  baseUrl: { mteam: 'https://api.m-team.cc', hdarea: 'https://hdarea.club', hdwing: 'https://hdwing.org' }[site],
  enabled: false,
  status: 'unconfigured',
  hasCredential: false,
  hasPasskey: false,
  requiresPasskey: site === 'hdarea',
  verifiedAt: null,
  lastError: null,
}));
function updateSite(site: ResourceSiteSnapshot['site'], update: Partial<ResourceSiteSnapshot>) {
  localSites = localSites.map((row) => (row.site === site ? { ...row, ...update } : row));
  return structuredClone(localSites.find((row) => row.site === site)!);
}
let downloaders: DownloaderProfile[] = configured
  ? [
      {
        id: 'preview-qbittorrent',
        provider: 'qbittorrent',
        downloaderUrl: settings.settings.downloaderUrl,
        username: 'popular',
        authMode: 'password',
        enabled: true,
        isDefault: true,
        hasPassword: true,
      },
      {
        id: 'preview-transmission',
        provider: 'transmission',
        downloaderUrl: 'http://192.168.1.30:9091/transmission/rpc',
        username: '',
        authMode: 'password',
        enabled: true,
        isDefault: false,
        hasPassword: false,
      },
    ]
  : [];
function activeDownloader() {
  const row = downloaders.find((row) => row.isDefault);
  if (row) {
    Object.assign(settings.settings, {
      provider: row.provider,
      downloaderUrl: row.downloaderUrl,
      username: row.username,
      authMode: row.authMode,
      downloaderConfigured: row.enabled,
    });
    settings.hasPassword = row.hasPassword;
    runtime.downloader = row.enabled ? 'online' : 'unconfigured';
  } else settings.settings.downloaderConfigured = false;
  return structuredClone(settings);
}
const client: AgentClient = {
  downloaderProfiles: {
    list: async () => structuredClone(downloaders),
    configure: async ({ id, configuration }) => {
      const existing = downloaders.find((row) => row.id === id);
      downloaders = downloaders.filter((row) => row.id !== id);
      const { password, ...values } = configuration;
      downloaders.push({
        ...values,
        id: id ?? crypto.randomUUID(),
        enabled: existing?.enabled ?? true,
        isDefault: existing?.isDefault ?? !downloaders.length,
        hasPassword: password.action === 'set' || !!existing?.hasPassword,
      });
      return activeDownloader();
    },
    action: async (request) => {
      if (request.operation === 'remove') downloaders = downloaders.filter((row) => row.id !== request.id);
      else
        downloaders = downloaders.map((row) => ({
          ...row,
          ...(request.operation === 'default'
            ? { isDefault: row.id === request.id }
            : row.id === request.id
              ? { enabled: !!request.enabled }
              : {}),
        }));
      return activeDownloader();
    },
  },
  resourceSites: {
    setDefault: async (site) => {
      localSites = localSites.map((row) => ({ ...row, isDefault: row.site === site }));
      return structuredClone(localSites);
    },
    list: async () => structuredClone(localSites),
    configure: async (request) =>
      updateSite(request.site, {
        baseUrl: request.baseUrl,
        status: 'configured_valid',
        enabled: true,
        hasCredential: true,
        hasPasskey: request.site === 'hdarea',
        verifiedAt: Date.now(),
      }),
    verify: async (site) => updateSite(site, { status: 'configured_valid', verifiedAt: Date.now() }),
    setEnabled: async (site, enabled) => updateSite(site, { enabled }),
    remove: async (site) => {
      updateSite(site, {
        status: 'unconfigured',
        hasCredential: false,
        hasPasskey: false,
        enabled: false,
        verifiedAt: null,
      });
    },
  },
  loadSettings: async () => structuredClone(settings),
  getRuntime: async () => {
    if (state === 'error') throw 'networkError';
    return { ...runtime };
  },
  connectGateway: async (request) => {
    settings = { ...settings, settings: { ...settings.settings, gatewayUrl: request.gatewayUrl }, hasApiKey: true };
    runtime.service = 'online';
    runtime.binding = 'bound';
    runtime.deviceId = 'preview-device';
    return structuredClone(settings);
  },
  disconnectGateway: async () => {
    runtime.service = 'manuallyDisconnected';
  },
  testDownloader: async (request) => {
    const { password, ...target } = request;
    settings = {
      ...settings,
      settings: { ...settings.settings, ...target, downloaderConfigured: true },
      hasPassword: password.action === 'set',
    };
    runtime.downloader = 'online';
    return structuredClone(settings);
  },
  resetDownloader: async () => {
    settings.settings.downloaderConfigured = false;
    settings.hasPassword = false;
    runtime.downloader = 'unconfigured';
    return structuredClone(settings);
  },
  saveLocale: async (next) => {
    settings.settings.locale = next;
    if (banner) banner.textContent = messages[next].previewNotice;
  },
  getDownloadHistory: async () => [
    {
      downloadId: 'preview-download',
      executionId: 'preview-execution',
      provider: 'qbittorrent',
      phase: 'succeeded',
      state: 'completed',
      progress: 1,
    },
  ],
  getQueue: async () => ({
    stale: false,
    loading: false,
    snapshot: {
      observedAt: Date.now(),
      total: configured ? 1 : 0,
      nextCursor: null,
      items: configured
        ? [
            {
              commandId: 'preview-command',
              resourceId: '42',
              source: 'mteam',
              title: messages[settings.settings.locale].previewTaskTitle,
              enqueuedAt: Date.now() - 3600000,
              expiresAt: Date.now() + 86400000 * 3,
              reason: 'torrent_daily_limit',
              limitDetectedAt: Date.now() - 3600000,
              lastAttemptAt: Date.now() - 3600000,
              nextAttemptAt: Date.now() + 86400000 - 3600000,
            },
          ]
        : [],
    },
  }),
  setQueuePage: async () => {},
};
const host: AgentHost = {
  version: manifest.version,
  openDocumentation: async () => {},
  onNavigate: async (handler) => {
    const page = params.get('page');
    if (page && ['overview', 'resource-sites', 'downloaders', 'tasks', 'settings'].includes(page))
      handler(page as AgentPage);
    return () => {};
  },
};
createApp(AgentRoot, { client, host }).mount('#app');
