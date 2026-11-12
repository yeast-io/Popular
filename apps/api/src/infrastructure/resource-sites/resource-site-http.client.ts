import { CookieJar } from 'tough-cookie';
import { setTimeout as delay } from 'node:timers/promises';
import type { ResourceSiteHttpOptions, ResourceSiteHttpLane } from './resource-site-http.types.js';
import type {
  ResourceSiteSession,
  ResourceSiteHttpClientPort,
} from '../../modules/resource-sites/resource-site.types.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';
import { resourceSiteEndpoint, resourceSiteRedirectTarget } from './resource-site-redirect.domain.js';
import {
  RESOURCE_SITE_HTTP_INTERVAL_MS,
  RESOURCE_SITE_HTTP_MAX_BYTES,
  RESOURCE_SITE_HTTP_MAX_PENDING,
  RESOURCE_SITE_HTTP_TIMEOUT_MS,
  RESOURCE_SITE_HTTP_MAX_REDIRECTS,
} from './resource-site-http.policy.js';
import { aiStep, currentAiTrace } from '../logging/ai-trace.js';

/** Scheduling is shared; Cookie jars are created for each credential-bound operation. */
export class ResourceSiteHttpClient implements ResourceSiteHttpClientPort {
  private readonly lanes = new Map<string, ResourceSiteHttpLane>();

  constructor(private readonly options: ResourceSiteHttpOptions = {}) {}

  async session(baseUrl: string, cookie: string): Promise<ResourceSiteSession> {
    const origin = new URL(baseUrl).origin;
    const jar = new CookieJar();
    if (!cookie.trim() || /[\r\n]/.test(cookie)) throw new ResourceSiteError('invalidCredential');
    for (const pair of cookie.split(';').filter((part) => part.trim())) {
      if (!/^[^=;\s]+=.*/.test(pair.trim())) throw new ResourceSiteError('invalidCredential');
      await jar.setCookie(`${pair.trim()}; Path=/; Secure`, baseUrl);
    }
    return {
      get: async (path, signal) => {
        const url = new URL(path, baseUrl);
        if (url.origin !== origin || url.username || url.password || url.protocol !== 'https:')
          throw new ResourceSiteError('invalidResponse');
        const budget = AbortSignal.timeout(this.options.timeoutMs ?? RESOURCE_SITE_HTTP_TIMEOUT_MS);
        const bounded = signal ? AbortSignal.any([budget, signal]) : budget;
        try {
          return await this.schedule(origin, bounded, async () => {
            let current = url;
            const visited = new Set<string>();
            for (let redirects = 0; redirects <= RESOURCE_SITE_HTTP_MAX_REDIRECTS; redirects++) {
              if (visited.has(current.href)) throw new ResourceSiteError('redirected');
              visited.add(current.href);
              bounded.throwIfAborted();
              const cookieHeader = await jar.getCookieString(current.href);
              currentAiTrace()?.sensitive(cookieHeader);
              const response = await aiStep(
                'resource-sites.http.request',
                () => {
                  return (this.options.fetch ?? fetch)(current, {
                    headers: { 'Cookie': cookieHeader, 'Referer': baseUrl, 'User-Agent': 'Popular/1.0' },
                    redirect: 'manual',
                    signal: bounded,
                  });
                },
                { host: origin, path: resourceSiteEndpoint(current), attempt: 1, redirectCount: redirects }
              );
              currentAiTrace()?.event('resource-sites.http.response', { host: origin, httpStatus: response.status, redirectCount: redirects });
              for (const value of response.headers.getSetCookie()) {
                currentAiTrace()?.sensitive(value);
                const pair = value.split(';')[0] ?? '';
                currentAiTrace()?.sensitive(pair.slice(pair.indexOf('=') + 1));
                await jar.setCookie(value, current.href);
              }
              if ([301, 302, 303, 307, 308].includes(response.status)) {
                await response.body?.cancel();
                if (redirects === RESOURCE_SITE_HTTP_MAX_REDIRECTS) throw new ResourceSiteError('redirected');
                current = resourceSiteRedirectTarget(current, response.headers.get('location'), origin);
                // Redirects also consume the site's request interval.
                await delay(this.options.intervalMs ?? RESOURCE_SITE_HTTP_INTERVAL_MS, undefined, { signal: bounded });
                continue;
              }
              if (!response.ok) {
                await response.body?.cancel();
                if (response.status === 429) {
                  const retry = response.headers.get('retry-after');
                  let waitMs = 60_000;
                  if (retry) waitMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
                  const cooldownMs = Math.max(60_000, Number.isFinite(waitMs) ? waitMs : 60_000);
                  this.lanes.get(origin)!.blockedUntil = Date.now() + cooldownMs;
                  throw new ResourceSiteError('rateLimited');
                }
                throw new ResourceSiteError(
                  response.status === 401 ? 'authentication' : response.status === 403 ? 'blocked' : 'network'
                );
              }
              const max = this.options.maxBytes ?? RESOURCE_SITE_HTTP_MAX_BYTES;
              if (Number(response.headers.get('content-length')) > max) {
                await response.body?.cancel();
                throw new ResourceSiteError('invalidResponse');
              }
              const reader = response.body?.getReader();
              if (!reader) throw new ResourceSiteError('invalidResponse');
              const chunks: Uint8Array[] = [];
              let size = 0;
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  size += value.length;
                  if (size > max) throw new ResourceSiteError('invalidResponse');
                  chunks.push(value);
                }
              } finally {
                // Cleanup must not replace the original body/size/abort error.
                try {
                  await reader.cancel();
                } catch {
                  /* The response stream is already closed or failed. */
                }
              }
              return Buffer.concat(chunks);
            }
            throw new ResourceSiteError('redirected');
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof ResourceSiteError) throw error;
          throw new ResourceSiteError(budget.aborted ? 'timeout' : 'network', { cause: error });
        }
      },
    };
  }

  /** API credentials are header-only; credentialed redirects are restricted to the same origin. */
  async apiSession(baseUrl: string, apiKey: string): Promise<ResourceSiteSession> {
    if (!/^[a-f0-9]{32}$/i.test(apiKey)) throw new ResourceSiteError('invalidCredential');
    const origin = new URL(baseUrl).origin;
    const request = async (path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Uint8Array> => {
      const url = new URL(path, baseUrl);
      const api = url.pathname.startsWith('/api/v1/');
      if (
        url.origin !== origin
        || url.protocol !== 'https:'
        || url.username
        || url.password
        || url.hash
        || (!api && (url.pathname !== '/download.php' || body !== undefined))
        || [...url.searchParams.keys()].some((key) => /^(?:apikey|passkey)$/i.test(key))
      )
        throw new ResourceSiteError('invalidResponse');
      currentAiTrace()?.sensitive(apiKey);
      if (!api) {
        currentAiTrace()?.sensitive(url.href);
        for (const value of url.searchParams.values()) currentAiTrace()?.sensitive(value);
      }
      const budget = AbortSignal.timeout(this.options.timeoutMs ?? RESOURCE_SITE_HTTP_TIMEOUT_MS);
      const bounded = signal ? AbortSignal.any([signal, budget]) : budget;
      try {
        return await this.schedule(origin, bounded, () =>
          aiStep(
            'resource-sites.api.exchange',
            async () => {
              let current = url;
              let method = body ? 'POST' : 'GET';
              let payload = body ? JSON.stringify(body) : undefined;
              const visited = new Set<string>();
              for (let redirects = 0; redirects <= RESOURCE_SITE_HTTP_MAX_REDIRECTS; redirects++) {
                bounded.throwIfAborted();
                if (visited.has(current.href)) throw new ResourceSiteError('redirected');
                visited.add(current.href);
                const response = await aiStep(
                  'resource-sites.api.http.request',
                  () =>
                    (this.options.fetch ?? fetch)(current, {
                      method,
                      headers: {
                        'User-Agent': 'Popular/1.0',
                        ...(api ? { 'X-API-Key': apiKey } : {}),
                        ...(payload ? { 'Content-Type': 'application/json' } : {}),
                      },
                      ...(payload ? { body: payload } : {}),
                      redirect: 'manual',
                      credentials: 'omit',
                      signal: bounded,
                    }),
                  { host: current.origin, path: resourceSiteEndpoint(current), attempt: 1, redirectCount: redirects }
                );
                currentAiTrace()?.event('resource-sites.api.http.response', {
                  host: current.origin,
                  path: resourceSiteEndpoint(current),
                  httpStatus: response.status,
                  redirectCount: redirects,
                  outcome: response.ok ? 'success' : 'failure',
                });
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                  await response.body?.cancel();
                  if (redirects === RESOURCE_SITE_HTTP_MAX_REDIRECTS) throw new ResourceSiteError('redirected');
                  current = resourceSiteRedirectTarget(current, response.headers.get('location'), api ? origin : undefined);
                  if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
                    method = 'GET';
                    payload = undefined;
                  }
                  await delay(this.options.intervalMs ?? RESOURCE_SITE_HTTP_INTERVAL_MS, undefined, { signal: bounded });
                  continue;
                }
                if (!response.ok) {
                  const cause = new Error(`Resource site HTTP ${response.status} at ${resourceSiteEndpoint(current)}`);
                  await response.body?.cancel();
                  if (response.status === 429) {
                    const retry = response.headers.get('retry-after');
                    const ms
                      = retry && /^\d+$/.test(retry)
                        ? Number(retry) * 1000
                        : retry
                          ? Date.parse(retry) - Date.now()
                          : 60_000;
                    this.lanes.get(origin)!.blockedUntil = Date.now() + Math.max(1000, Number.isFinite(ms) ? ms : 60_000);
                    throw new ResourceSiteError('rateLimited', { cause });
                  }
                  if (response.status === 403 && !api) throw new ResourceSiteError('downloadExpired', { cause });
                  if (response.status === 401 || response.status === 403) throw new ResourceSiteError('authentication', { cause });
                  if (response.status >= 300 && response.status < 400) throw new ResourceSiteError('blocked', { cause });
                  throw new ResourceSiteError('invalidResponse', { cause });
                }
                const max = this.options.maxBytes ?? RESOURCE_SITE_HTTP_MAX_BYTES;
                if (Number(response.headers.get('content-length')) > max) {
                  await response.body?.cancel();
                  throw new ResourceSiteError('invalidResponse');
                }
                const reader = response.body?.getReader();
                if (!reader) throw new ResourceSiteError('invalidResponse');
                const chunks: Uint8Array[] = [];
                let size = 0;
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > max) throw new ResourceSiteError('invalidResponse');
                    chunks.push(value);
                  }
                } finally {
                  try {
                    await reader.cancel();
                  } catch {
                    /* Preserve the original stream failure. */
                  }
                }
                return Buffer.concat(chunks);
              }
              throw new ResourceSiteError('redirected');
            },
            { host: origin, path: url.pathname, attempt: 1 }
          )
        );
      } catch (cause) {
        if (cause instanceof ResourceSiteError || signal?.aborted) throw cause;
        throw new ResourceSiteError(budget.aborted ? 'timeout' : 'network', { cause });
      }
    };
    return {
      get: (path, signal) => request(path, undefined, signal),
      post: (path, body, signal) => request(path, body, signal),
    };
  }

  private async schedule<T>(origin: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(origin);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0, nextAt: 0, blockedUntil: 0 };
      this.lanes.set(origin, lane);
    }
    if (lane.pending >= RESOURCE_SITE_HTTP_MAX_PENDING || lane.blockedUntil > Date.now())
      throw new ResourceSiteError('rateLimited');
    const previous = lane.tail;
    let release!: () => void;
    lane.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    lane.pending++;
    try {
      // Pending requests have a bounded lifetime even while the previous request is running.
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        previous.then(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      if (lane.blockedUntil > Date.now()) throw new ResourceSiteError('rateLimited');
      const wait = lane.nextAt - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal });
      return await action();
    } finally {
      // Preserve queue order when an aborted waiter leaves before its predecessor.
      previous.then(() => {
        lane.nextAt = Date.now() + (this.options.intervalMs ?? RESOURCE_SITE_HTTP_INTERVAL_MS);
        lane.pending--;
        release();
      });
    }
  }
}
