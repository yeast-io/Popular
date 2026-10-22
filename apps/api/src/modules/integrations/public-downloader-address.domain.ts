import { isIP } from 'node:net';

/** Reject local/private IP literals and local hostnames for direct downloader configuration. */
export function isPublicDownloaderAddress(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host) === 4) {
    const [first = 0, second = 0, third = 0] = host.split('.').map(Number);
    return !(
      first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && ((second === 0 && (third === 0 || third === 2)) || second === 168))
      || (first === 192 && second === 88 && third === 99)
      || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
      || (first === 203 && second === 0 && third === 113)
    );
  }
  if (host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6) {
    const address = host.slice(1, -1);
    const [first = 0, second = 0] = address.split(':').map((part) => Number.parseInt(part || '0', 16));
    return first >= 0x2000 && first <= 0x3fff
      && !(first === 0x2001 && (second === 0 || second === 0xdb8))
      && first !== 0x2002;
  }
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
