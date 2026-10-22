import type { DownloaderAddress, Provider } from './settings.types';

export function defaultPort(provider: Provider): string {
  return provider === 'transmission' ? '9091' : '8080';
}

export function parseDownloaderAddress(raw: string, provider: Provider): DownloaderAddress {
  const url = new URL(raw.includes('://') ? raw.trim() : `http://${raw.trim()}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalidUrl');
  }
  const authority = raw.trim().replace(/^https?:\/\//, '').split('/')[0] ?? '';
  const explicitPort = authority.match(/:(\d+)$/)?.[1];
  return {
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname + (url.pathname === '/' || (provider === 'transmission' && url.pathname === '/transmission/rpc') ? '' : url.pathname),
    port: explicitPort ?? defaultPort(provider),
  };
}

export function downloaderAddressUrl(address: DownloaderAddress, provider: Provider): string {
  const host = address.host.trim();
  // A pasted complete URL carries its own protocol and port until the input is committed.
  if (host.includes('://')) return host;
  const slash = host.indexOf('/');
  const authority = slash < 0 ? host : host.slice(0, slash);
  const path = slash < 0 ? '' : host.slice(slash);
  const port = /:\d+$/.test(authority) ? '' : `:${address.port.trim() || defaultPort(provider)}`;
  return `${address.protocol}://${authority}${port}${path}`;
}
