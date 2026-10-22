import { CookieJar } from 'tough-cookie';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ResourceSiteHttpOptions,
  ResourceSiteHttpLane,
  ResourceSiteSession,
} from '../../modules/resource-sites/resource-site.types.js';
import { ResourceSiteError } from '../../modules/resource-sites/resource-site.errors.js';
import {
  RESOURCE_SITE_INTERVAL_MS,
  RESOURCE_SITE_MAX_BYTES,
  RESOURCE_SITE_MAX_PENDING,
  RESOURCE_SITE_TIMEOUT_MS,
} from '../../modules/resource-sites/resource-site.policy.js';
import { aiStep, currentAiTrace } from '../logging/ai-trace.js';

/** Scheduling is shared; Cookie jars are created for each credential-bound operation. */
export class ResourceSiteHttpClient {
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
        const budget = AbortSignal.timeout(this.options.timeoutMs ?? RESOURCE_SITE_TIMEOUT_MS);
        const bounded = signal ? AbortSignal.any([budget, signal]) : budget;
        try {
          return await this.schedule(origin, bounded, async () => {
            let current = url;
            for (let redirects = 0; redirects <= 3; redirects++) {
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
                  }
                  );
                },
                { host: origin, path: current.pathname, attempt: 1 }
              );
              for (const value of response.headers.getSetCookie()) {
                currentAiTrace()?.sensitive(value);
                const pair = value.split(';')[0] ?? '';
                currentAiTrace()?.sensitive(pair.slice(pair.indexOf('=') + 1));
                await jar.setCookie(value, current.href);
              }
              if ([301, 302, 303, 307, 308].includes(response.status)) {
                await response.body?.cancel();
                const location = response.headers.get('location');
                if (!location) throw new ResourceSiteError('invalidResponse');
                const next = new URL(location, current);
                if (next.origin !== origin || next.username || next.password) throw new ResourceSiteError('blocked');
                if (/login|verify|captcha/i.test(next.pathname)) throw new ResourceSiteError('authentication');
                current = next;
                // Redirects also consume the site's request interval.
                await delay(this.options.intervalMs ?? RESOURCE_SITE_INTERVAL_MS, undefined, { signal: bounded });
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
              const max = this.options.maxBytes ?? RESOURCE_SITE_MAX_BYTES;
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
            throw new ResourceSiteError('invalidResponse');
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof ResourceSiteError) throw error;
          throw new ResourceSiteError(budget.aborted ? 'timeout' : 'network', { cause: error });
        }
      },
    };
  }

  private async schedule<T>(origin: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(origin);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0, nextAt: 0, blockedUntil: 0 };
      this.lanes.set(origin, lane);
    }
    if (lane.pending >= RESOURCE_SITE_MAX_PENDING || lane.blockedUntil > Date.now())
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
        lane.nextAt = Date.now() + (this.options.intervalMs ?? RESOURCE_SITE_INTERVAL_MS);
        lane.pending--;
        release();
      });
    }
  }
}
