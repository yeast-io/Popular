import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';
import { currentAiTrace } from '../logging/ai-trace.js';

export function resourceSiteRedirectTarget(current: URL, location: string | null, credentialOrigin?: string): URL {
  if (!location?.trim()) throw new ResourceSiteError('redirected');
  currentAiTrace()?.sensitive(location);
  let next: URL;
  try {
    next = new URL(location, current);
  } catch (cause) {
    throw new ResourceSiteError('redirected', { cause });
  }
  currentAiTrace()?.sensitive(next.href);
  if (next.protocol !== 'https:' || next.username || next.password || next.hash
    || (credentialOrigin !== undefined && next.origin !== credentialOrigin))
    throw new ResourceSiteError('redirected');
  if (/login|verify|captcha/i.test(next.pathname)) throw new ResourceSiteError('authentication');
  currentAiTrace()?.event('resource-sites.http.redirect', { sourceOrigin: current.origin, targetOrigin: next.origin });
  return next;
}

export function resourceSiteEndpoint(url: URL): string {
  const path = url.pathname;
  if (/^\/api\/v1\/torrents\/\d{1,32}$/.test(path)) return '/api/v1/torrents/:id';
  return ['/', '/index.php', '/login.php', '/login', '/torrents.php', '/details.php', '/download.php',
    '/api/member/profile', '/api/torrent/search', '/api/torrent/detail', '/api/torrent/genDlToken',
    '/api/v1/user/profile', '/api/v1/torrents', '/api/v1/torrents/genDlToken'].includes(path)
    ? path
    : '<redacted>';
}
