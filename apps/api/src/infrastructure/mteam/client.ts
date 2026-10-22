import { MTeamMemberProfileSchema } from './member-profile.schema.js';
import { parseTorrentUrl } from './torrent-url.schema.js';
import { releaseTitleMetadata } from '../../modules/resource-sites/release-metadata.domain.js';
import type { MTeamSearchPage, MTeamSearchOptions } from '../../modules/integrations/movie-resource-check.types.js';
import { AiTrace, currentAiTrace, withAiTrace } from '../logging/ai-trace.js';
import type { AiLogger } from '../logging/ai-trace.types.js';
import { MTeamHttpError, parseRetryAfter, retryMTeamSearch } from './search-retry.js';
import type { LookupAddress } from 'node:dns';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { IntegrationValidationError } from '../../modules/integrations/integration.service.js';
import type {
  MTeamRelease,
  MTeamResourceSearcher,
  MTeamTorrentUrlProvider,
} from '../../modules/integrations/movie-resource-check.types.js';
import type { MTeamVerifier } from '../../modules/integrations/integration.types.js';
import type {
  ExternalRequestContext,
  ExternalRequestErrorCode,
  ExternalRequestRecorder,
} from '../../modules/external-usage/external-usage.types.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;

export class MTeamClient implements MTeamVerifier, MTeamResourceSearcher, MTeamTorrentUrlProvider {
  constructor(
    private readonly timeoutMs: number,
    private readonly usage?: ExternalRequestRecorder,
    private readonly searchOptions: { minimumIntervalMs: number; logger?: AiLogger; verbose?: boolean } = {
      minimumIntervalMs: 2500,
    }
  ) {}

  async verify(baseUrl: string, apiKey: string, context?: ExternalRequestContext): Promise<string> {
    const body = await withAbsoluteTimeout(this.timeoutMs, async (signal) => {
      const url = verificationUrl(baseUrl);
      const addresses = await resolvePublicAddresses(url.hostname);
      const address = addresses[0];
      if (!address) throw new IntegrationValidationError('network', 'M-Team hostname did not resolve');
      return this.observe('connection.test', context, () => {
        return postJson(url, apiKey, address, {}, signal, MAX_RESPONSE_BYTES);
      });
    });

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new IntegrationValidationError('invalid_response', 'M-Team returned invalid JSON', { cause: error });
    }
    if (!isSuccessPayload(payload)) {
      throw new IntegrationValidationError(
        isAuthenticationFailure(payload) ? 'authentication' : 'remote_error',
        'M-Team rejected the validation request'
      );
    }
    const identity = MTeamMemberProfileSchema.safeParse(payload);
    if (!identity.success) throw new IntegrationValidationError('invalid_response', 'M-Team profile has no valid current-user ID');
    return identity.data.data.id;
  }

  async searchMovies(
    baseUrl: string,
    apiKey: string,
    query: { imdbId: string } | { title: string },
    context?: ExternalRequestContext
  ): Promise<MTeamRelease[]> {
    return (await this.searchMoviePage(baseUrl, apiKey, query, context)).releases;
  }

  async searchMoviePage(
    baseUrl: string,
    apiKey: string,
    query: { imdbId: string } | { title: string },
    context?: ExternalRequestContext,
    options: MTeamSearchOptions = {}
  ): Promise<MTeamSearchPage> {
    const page = options.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 100) throw invalidSearchResponse();
    const execute = async () => {
      currentAiTrace()?.sensitive(apiKey);
      return retryMTeamSearch(
        async (attempt, operationId, parentSignal, remainingMs) => {
          return this.observe(
            'release.search',
            context,
            async () => {
              const body = await withAbsoluteTimeout(
                Math.min(this.timeoutMs, remainingMs),
                async (signal) => {
                  const url = apiUrl(baseUrl, 'torrent/search');
                  const addresses = await resolvePublicAddresses(url.hostname);
                  const address = addresses[0];
                  if (!address) throw new IntegrationValidationError('network', 'M-Team hostname did not resolve');
                  return postJson(
                    url,
                    apiKey,
                    address,
                    {
                      pageNumber: page,
                      pageSize: 100,
                      mode: 'movie',
                      visible: 1,
                      sortField: 'SEEDERS',
                      sortDirection: 'DESC',
                      ...('imdbId' in query
                        ? { imdb: `https://www.imdb.com/title/${normalizeImdbId(query.imdbId)}/` }
                        : { keyword: query.title }),
                    },
                    signal,
                    MAX_SEARCH_RESPONSE_BYTES
                  );
                },
                { signal: parentSignal, message: 'M-Team resource query timed out' }
              );
              let payload: unknown;
              try {
                payload = JSON.parse(body);
              } catch (error) {
                throw new IntegrationValidationError('invalid_response', 'M-Team returned invalid JSON', {
                  cause: error,
                });
              }
              if (!isSuccessPayload(payload)) {
                const failureType = isAuthenticationFailure(payload)
                  ? 'authentication'
                  : isPermissionFailure(payload)
                    ? 'permission'
                    : 'remote_error';
                throw new IntegrationValidationError(failureType, 'M-Team rejected the search request');
              }
              return parseSearchPage(payload, page);
            },
            { attempt, operationId }
          );
        },
        { ...this.searchOptions, ...(options.signal ? { signal: options.signal } : {}) }
      );
    };
    if (currentAiTrace()) return execute();
    const trace = new AiTrace(
      this.searchOptions.logger,
      {
        provider: 'mteam',
        ...(context?.ownerId ? { ownerId: context.ownerId } : {}),
      },
      apiKey,
      'mteam.search',
      this.searchOptions.verbose ?? false
    );
    return withAiTrace(trace, execute);
  }

  async torrentUrl(
    baseUrl: string,
    apiKey: string,
    releaseId: string,
    context?: ExternalRequestContext
  ): Promise<string> {
    currentAiTrace()?.sensitive(apiKey);
    const tokenBody = await withAbsoluteTimeout(this.timeoutMs, async (signal) => {
      const url = apiUrl(baseUrl, 'torrent/genDlToken');
      const addresses = await resolvePublicAddresses(url.hostname);
      const address = addresses[0];
      if (!address) throw new IntegrationValidationError('network', 'M-Team hostname did not resolve');
      return this.observe('torrent.download_token', context, () => {
        return postForm(
          url,
          apiKey,
          address,
          new URLSearchParams({ id: releaseId }).toString(),
          signal,
          MAX_RESPONSE_BYTES
        );
      });
    });
    let payload: unknown;
    try {
      payload = JSON.parse(tokenBody);
    } catch (error) {
      throw new IntegrationValidationError('invalid_response', 'M-Team returned invalid download-token JSON', {
        cause: error,
      });
    }
    if (!isSuccessPayload(payload))
      throw new IntegrationValidationError('remote_error', 'M-Team rejected the torrent download request');
    const tokenUrl = (payload as { data?: unknown }).data;
    if (typeof tokenUrl === 'string') currentAiTrace()?.sensitive(tokenUrl);
    const downloadUrl = parseTorrentUrl(payload);
    currentAiTrace()?.sensitive(downloadUrl);
    return downloadUrl;
  }

  private async observe<T>(
    operation: string,
    context: ExternalRequestContext | undefined,
    requestOperation: () => Promise<T>,
    metadata?: { attempt: number; operationId: string }
  ): Promise<T> {
    const startedAt = Date.now();
    const operationId = metadata?.operationId ?? randomUUID();
    try {
      const result = await requestOperation();
      await this.record(context, {
        operation,
        operationId,
        attempt: metadata?.attempt ?? 1,
        outcome: 'success',
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      await this.record(context, {
        operation,
        operationId,
        attempt: metadata?.attempt ?? 1,
        outcome: 'failure',
        durationMs: Date.now() - startedAt,
        errorCode: mteamErrorCode(error),
      });
      throw error;
    }
  }

  private async record(
    context: ExternalRequestContext | undefined,
    event: {
      operation: string;
      operationId: string;
      attempt?: number;
      outcome: 'success' | 'failure';
      durationMs: number;
      errorCode?: ExternalRequestErrorCode;
    }
  ): Promise<void> {
    if (!context || !this.usage) return;
    try {
      await this.usage.record({
        ...context,
        ...event,
        provider: 'mteam',
        attempt: event.attempt ?? 1,
        occurredAt: new Date(),
      });
    } catch {
      // Usage telemetry must never change the upstream request result.
    }
  }
}

function mteamErrorCode(error: unknown): ExternalRequestErrorCode {
  return error instanceof IntegrationValidationError ? error.failureType : 'internal_error';
}

export async function withAbsoluteTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; message?: string } = {}
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new IntegrationValidationError('timeout', options.message ?? 'M-Team request timed out');
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([operation(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function resolvePublicAddresses(hostname: string): Promise<LookupAddress[]> {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname))
      throw new IntegrationValidationError('network', 'Private network addresses are not allowed');
    return [{ address: hostname, family: isIP(hostname) }];
  }
  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new IntegrationValidationError('network', 'M-Team hostname could not be resolved', { cause: error });
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new IntegrationValidationError('network', 'M-Team hostname resolved to a non-public address');
  }
  return addresses;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a = 0, b = 0, c = 0] = octets;
    return !(
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1') return false;
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return false;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isPublicAddress(mapped) : true;
  }
  return false;
}

export function verificationUrl(baseUrl: string): URL {
  return apiUrl(baseUrl, 'member/profile');
}

function apiUrl(baseUrl: string, path: string): URL {
  const normalized = baseUrl.endsWith('/api') ? baseUrl : `${baseUrl}/api`;
  return new URL(`${normalized}/${path}`);
}

export function createPinnedLookup(address: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

function postJson(
  url: URL,
  apiKey: string,
  address: LookupAddress,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
  maxResponseBytes: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      signal,
      family: address.family,
      headers: {
        'accept': 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        'user-agent': 'MovieHub/1.0',
        'x-api-key': apiKey,
      },
      lookup: createPinnedLookup(address),
    };
    const req = request(url, options, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(
          new MTeamHttpError(
            classifyMTeamHttpFailure(response.statusCode),
            response.statusCode ?? 0,
            parseRetryAfter(
              Array.isArray(response.headers['retry-after'])
                ? response.headers['retry-after'][0]
                : response.headers['retry-after']
            )
          )
        );
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxResponseBytes)
          response.destroy(new IntegrationValidationError('invalid_response', 'M-Team response is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', (error) => {
        return reject(
          error instanceof IntegrationValidationError
            ? error
            : new IntegrationValidationError('network', 'Could not read M-Team response', { cause: error })
        );
      });
    });
    req.on('error', (error) => {
      const reason
        = signal.aborted && signal.reason instanceof IntegrationValidationError
          ? signal.reason
          : error instanceof IntegrationValidationError
            ? error
            : new IntegrationValidationError('network', 'Could not connect to M-Team', { cause: error });
      reject(reason);
    });
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

function postForm(
  url: URL,
  apiKey: string,
  address: LookupAddress,
  body: string,
  signal: AbortSignal,
  maxResponseBytes: number
): Promise<string> {
  return requestBytes(
    url,
    address,
    signal,
    maxResponseBytes,
    {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'user-agent': 'MovieHub/1.0',
        'x-api-key': apiKey,
      },
    },
    body
  ).then((value) => value.toString('utf8'));
}

function requestBytes(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
  maxResponseBytes: number,
  options: { method: string; headers: Record<string, string | number> },
  body?: string
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { ...options, signal, family: address.family, lookup: createPinnedLookup(address) },
      (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(
            new IntegrationValidationError(
              classifyMTeamHttpFailure(response.statusCode),
              `M-Team returned HTTP ${response.statusCode ?? 'unknown'}`
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > maxResponseBytes)
            response.destroy(new IntegrationValidationError('invalid_response', 'M-Team response is too large'));
          else chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', (error) => {
          return reject(
            new IntegrationValidationError('invalid_response', 'Could not read M-Team response', { cause: error })
          );
        });
      });
    req.on('error', (error) => {
      return reject(
        signal.aborted && signal.reason instanceof IntegrationValidationError
          ? signal.reason
          : error instanceof IntegrationValidationError
            ? error
            : new IntegrationValidationError('network', 'Could not connect to M-Team', { cause: error })
      );
    });
    req.end(body);
  });
}

export function classifyMTeamHttpFailure(statusCode: number | undefined): IntegrationValidationError['failureType'] {
  if (statusCode === 401) return 'authentication';
  if (statusCode === 403) return 'permission';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 408) return 'timeout';
  return 'remote_error';
}

function isSuccessPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || !('code' in payload)) return false;
  const code = (payload as { code?: unknown }).code;
  return code === 0 || code === '0' || code === 'SUCCESS';
}

function isAuthenticationFailure(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as { code?: unknown; message?: unknown };
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
  return value.code === 401 || value.code === '401' || /key|token|auth|令牌|無效|无效/.test(message);
}

function isPermissionFailure(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const message
    = typeof (payload as { message?: unknown }).message === 'string'
      ? (payload as { message: string }).message.toLowerCase()
      : '';
  return /permission|forbidden|權限|权限/.test(message);
}

export function parseSearchPage(payload: unknown, page: number): MTeamSearchPage {
  const releases = parseSearchReleases(payload);
  const data = (payload as { data?: unknown }).data;
  const rawTotal
    = data && !Array.isArray(data) && typeof data === 'object' ? (data as { total?: unknown }).total : undefined;
  const total
    = typeof rawTotal === 'number' || (typeof rawTotal === 'string' && /^\d+$/.test(rawTotal))
      ? Number(rawTotal)
      : undefined;
  const hasNext
    = total !== undefined && Number.isSafeInteger(total) && total >= 0 ? page * 100 < total : releases.length === 100;
  return { releases, ...(hasNext && page < 100 ? { nextPage: page + 1 } : {}) };
}

export function parseSearchReleases(payload: unknown): MTeamRelease[] {
  if (!payload || typeof payload !== 'object') throw invalidSearchResponse();
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') throw invalidSearchResponse();
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : Array.isArray((data as { list?: unknown }).list)
        ? (data as { list: unknown[] }).list
        : null;
  if (!rows) throw invalidSearchResponse();
  return rows.map((row) => parseRelease(row));
}

function parseRelease(value: unknown): MTeamRelease {
  if (!value || typeof value !== 'object') throw invalidSearchResponse();
  const row = value as Record<string, unknown>;
  if (!row.status || typeof row.status !== 'object') throw invalidSearchResponse();
  const status = row.status as Record<string, unknown>;
  const seeders = parseNonNegativeInteger(status.seeders);
  const leechers = parseNonNegativeInteger(status.leechers);
  const visible = parseBoolean(status.visible);
  const banned = parseBoolean(status.banned);
  if (seeders === null || visible === null || banned === null) throw invalidSearchResponse();
  const imdbId = typeof row.imdb === 'string' ? extractImdbId(row.imdb) : undefined;
  const sizeBytes = parseNonNegativeInteger(row.size);
  const id = readString(row.id);
  const title = readString(row.name);
  const publishedAt = readString(row.createdDate);
  const discount = readString(status.discount);
  const resolution = describeCode(readString(row.standard), resolutionNames);
  const medium = describeCode(readString(row.medium), mediumNames);
  const videoCodec = describeCode(readString(row.videoCodec), videoCodecNames);
  const audioCodec = describeCode(readString(row.audioCodec), audioCodecNames);
  if (!id || !title) throw invalidSearchResponse();
  const releaseGroup = releaseTitleMetadata(title).releaseGroup;
  const tags = Array.isArray(row.labelsNew)
    ? row.labelsNew
        .filter((tag): tag is string => {
          return typeof tag === 'string' && tag.trim().length > 0;
        })
        .map((tag) => {
          return tag.trim();
        })
    : undefined;
  return {
    id,
    title,
    ...(imdbId ? { imdbId } : {}),
    visible,
    banned,
    seeders,
    ...(leechers !== null ? { leechers } : {}),
    ...(sizeBytes !== null ? { sizeBytes } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(discount ? { discount } : {}),
    ...(resolution ? { resolution } : {}),
    ...(medium ? { medium } : {}),
    ...(videoCodec ? { videoCodec } : {}),
    ...(audioCodec ? { audioCodec } : {}),
    ...(releaseGroup ? { releaseGroup } : {}),
    ...(tags ? { tags } : {}),
  };
}

const resolutionNames: Readonly<Record<string, string>> = {
  1: '1080p',
  2: '1080i',
  3: '720p',
  5: 'SD',
  6: '4K',
  7: '8K',
};
const mediumNames: Readonly<Record<string, string>> = {
  1: 'Blu-ray',
  2: 'HD DVD',
  3: 'Remux',
  4: 'Blu-ray',
  5: 'HDTV',
  6: 'DVD',
  7: 'Encode',
  8: 'CD',
  10: 'WEB',
};
const videoCodecNames: Readonly<Record<string, string>> = {
  1: 'H.264',
  2: 'VC-1',
  3: 'Xvid',
  4: 'MPEG-2',
  16: 'H.265',
  19: 'AV1',
  21: 'VP8/9',
  22: 'AVS',
};
const audioCodecNames: Readonly<Record<string, string>> = {
  1: 'FLAC',
  2: 'APE',
  3: 'DTS',
  4: 'MP2/3',
  5: 'OGG',
  6: 'AAC',
  7: 'Other',
  8: 'AC3',
  9: 'TrueHD',
  10: 'TrueHD Atmos',
  11: 'DTS-HD MA',
  12: 'E-AC3',
  13: 'E-AC3 Atmos',
  14: 'LPCM/PCM',
  15: 'WAV',
};

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function describeCode(value: string | undefined, names: Readonly<Record<string, string>>): string | undefined {
  return value ? (names[value] ?? value) : undefined;
}

function parseNonNegativeInteger(value: unknown): number | null {
  const number
    = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return null;
}

function extractImdbId(value: string): string | undefined {
  return value.match(/\b(tt\d{5,12})\b/i)?.[1]?.toLowerCase();
}

function normalizeImdbId(value: string): string {
  const imdbId = extractImdbId(value);
  if (!imdbId) throw new IntegrationValidationError('invalid_response', 'Movie has an invalid IMDb ID');
  return imdbId;
}

function invalidSearchResponse(): IntegrationValidationError {
  return new IntegrationValidationError('invalid_response', 'M-Team returned an invalid search response');
}
