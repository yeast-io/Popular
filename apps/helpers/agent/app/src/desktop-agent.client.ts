import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { AgentClient, AgentHost } from '@movie-hub/helper-agent-ui/transport';
import manifest from '../package.json';

export function createDesktopAgentClient(): AgentClient {
  return {
    downloaderProfiles: {
      list: () => invoke('downloaders_list'),
      configure: (request) => invoke('downloader_configure', { request }),
      action: (request) => invoke('downloader_action', { request }),
    },
    resourceSites: {
      setDefault: (site) => invoke('resource_site_default', { request: { site } }),
      list: () => invoke('resource_sites_list'),
      configure: (request) => invoke('resource_site_configure', { request }),
      verify: (site) => invoke('resource_site_verify', { request: { site } }),
      setEnabled: (site, enabled) => invoke('resource_site_enabled', { request: { site, enabled } }),
      remove: (site) => invoke('resource_site_remove', { request: { site } }),
    },
    loadSettings: () => invoke('load_settings'),
    getRuntime: () => invoke('runtime_status'),
    connectGateway: (request) => invoke('connect_device', { request }),
    disconnectGateway: () => invoke('disconnect_gateway'),
    testDownloader: (request) => invoke('test_downloader', { request }),
    resetDownloader: () => invoke('reset_downloader'),
    saveLocale: (locale) => invoke('save_locale', { locale }),
    getDownloadHistory: () => invoke('download_history'),
    getQueue: () => invoke('queue_status'),
    setQueuePage: (cursor) => invoke('queue_page', { cursor }),
  };
}
export function createDesktopAgentHost(): AgentHost {
  return {
    version: manifest.version,
    openDocumentation: (provider) => invoke('open_documentation', { provider }),
    setTitle: (title) => getCurrentWindow().setTitle(title),
    setAutostart: (enabled) => invoke('set_autostart', { enabled }),
    onNavigate: (handler) =>
      listen<string>('agent-page', ({ payload }) => {
        if (payload === 'queue') handler('tasks');
        else if (payload === 'settings') handler('settings');
      }),
  };
}
