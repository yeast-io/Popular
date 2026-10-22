export type Locale = 'en-US' | 'zh-CN';
export type Provider = 'qbittorrent' | 'transmission';
export interface Settings {
  locale: Locale;
  gatewayUrl: string;
  provider: Provider;
  downloaderUrl: string;
  username: string;
  autostart: boolean;
  gatewayEnabled: boolean;
  downloaderConfigured: boolean;
}
export interface Snapshot {
  settings: Settings;
  hasApiKey: boolean;
  hasPassword: boolean;
}
export type SecretChange = { action: 'keep' | 'clear' } | { action: 'set'; value: string };

export type BindingState = 'unbound' | 'binding' | 'bound' | 'rebindRequired';
export interface RuntimeStatus {
  service: string;
  downloader: string;
  deviceId: string | null;
  binding: BindingState;
  preferenceError: string | null;
}

export interface DownloaderAddress {
  protocol: 'http' | 'https';
  host: string;
  port: string;
}
