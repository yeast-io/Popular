import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/** Only ordinary globally routed unicast addresses may be used by direct downloaders. */
export function isPublicDownloaderIp(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  // IPv6 outside the global unicast allocation is not a public destination.
  return family === 4 || parsed.match(ipaddr.parse('2000::'), 3);
}

/** Reject local/private IP literals and local hostnames for direct downloader configuration. */
export function isPublicDownloaderAddress(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host) === 4) return isPublicDownloaderIp(host);
  if (host.startsWith('[') && host.endsWith(']')) return isPublicDownloaderIp(host.slice(1, -1));
  if (isIP(host) !== 0 || host.includes(':')) return false;
  const labels = host.split('.');
  const suffix = labels.at(-1)!;
  return labels.length >= 2
    && !['local', 'localhost', 'localdomain', 'lan', 'home', 'internal', 'invalid', 'test', 'example', 'onion', 'arpa'].includes(suffix)
    && /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(suffix)
    && suffix.length >= 2
    && /[a-z]/.test(suffix)
    && labels.every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label));
}

export function isPublicDownloaderUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && isPublicDownloaderAddress(url);
  } catch {
    return false;
  }
}
