import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { IntegrationValidationError } from '../../modules/integrations/integration.service.js';
import type { MTeamRelease, MTeamResourceSearcher, MTeamTorrentDownloader } from '../../modules/integrations/movie-resource-check.types.js';
import type { MTeamVerifier } from '../../modules/integrations/integration.types.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;

export class MTeamClient implements MTeamVerifier, MTeamResourceSearcher, MTeamTorrentDownloader {
  constructor(private readonly timeoutMs: number) {}

  async verify(baseUrl: string, apiKey: string): Promise<void> {
    const body = await withAbsoluteTimeout(this.timeoutMs, async (signal) => {
      const url = verificationUrl(baseUrl);
      const addresses = await resolvePublicAddresses(url.hostname);
      const address = addresses[0];
      if (!address) throw new IntegrationValidationError('network', 'M-Team hostname did not resolve');
      return postJson(url, apiKey, address, undefined, signal, MAX_RESPONSE_BYTES);
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
        'M-Team rejected the validation request',
      );
    }
  }

  async searchMovies(
    baseUrl: string,
    apiKey: string,
    query: { imdbId: string } | { title: string },
  ): Promise<MTeamRelease[]> {
    const body = await withAbsoluteTimeout(this.timeoutMs, async (signal) => {
      const url = apiUrl(baseUrl, 'torrent/search');
      const addresses = await resolvePublicAddresses(url.hostname);
      const address = addresses[0];
      if (!address) throw new IntegrationValidationError('network', 'M-Team hostname did not resolve');
      return postJson(url, apiKey, address, {
        pageNumber: 1,
        pageSize: 100,
        mode: 'movie',
        visible: 1,
        sortField: 'SEEDERS',
        sortDirection: 'DESC',
        ...('imdbId' in query
          ? { imdb: `https://www.imdb.com/title/${normalizeImdbId(query.imdbId)}/` }
          : { keyword: query.title }),
      }, signal, MAX_SEARCH_RESPONSE_BYTES);
    });

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new IntegrationValidationError('invalid_response', 'M-Team returned invalid JSON', { cause: error });
    }
    if (!isSuccessPayload(payload)) {
      const failureType = isAuthenticationFailure(payload)
        ? 'authentication'
        : isPermissionFailure(payload) ? 'permission' : 'remote_error';
      throw new IntegrationValidationError(failureType, 'M-Team rejected the search request');
    }
    return parseSearchReleases(payload);
  }

  async downloadTorrent(baseUrl: string, apiKey: string, releaseId: string): Promise<Uint8Array> {
    const tokenBody = await withAbsoluteTimeout(this.timeoutMs, async (signal) => {
      const url = apiUrl(baseUrl, 'torrent/genDlToken');
      const addresses = await resolvePublicAddresses(url.hostname);
      const address = addresses[0];
      if (!address) throw new IntegrationValidationError('network', 'M-Team hostname did not resolve');
      return postForm(url, apiKey, address, new URLSearchParams({ id: releaseId }).toString(), signal, MAX_RESPONSE_BYTES);
    });
    let payload: unknown;
    try { payload = JSON.parse(tokenBody); } catch (error) {
      throw new IntegrationValidationError('invalid_response', 'M-Team returned invalid download-token JSON', { cause: error });
    }
    if (!isSuccessPayload(payload)) throw new IntegrationValidationError('remote_error', 'M-Team rejected the torrent download request');
    const downloadUrl = typeof (payload as { data?: unknown }).data === 'string'
      ? new URL((payload as { data: string }).data)
      : null;
    if (!downloadUrl || downloadUrl.protocol !== 'https:' || downloadUrl.username || downloadUrl.password) {
      throw new IntegrationValidationError('invalid_response', 'M-Team returned an invalid torrent URL');
    }
    return withAbsoluteTimeout(this.timeoutMs, async (signal) => {
      return downloadPublicBytes(downloadUrl, signal, 10 * 1024 * 1024, 3);
    });
  }
}

export async function withAbsoluteTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new IntegrationValidationError('timeout', 'M-Team validation timed out');
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePublicAddresses(hostname: string): Promise<LookupAddress[]> {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new IntegrationValidationError('network', 'Private network addresses are not allowed');
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
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
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
  return apiUrl(baseUrl, 'member/sysRoleList');
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
  maxResponseBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      signal,
      family: address.family,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        'user-agent': 'MovieHub/1.0',
        'x-api-key': apiKey,
      },
      lookup: createPinnedLookup(address),
    };
    const req = request(url, options, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new IntegrationValidationError(
          classifyMTeamHttpFailure(response.statusCode),
          `M-Team returned HTTP ${response.statusCode ?? 'unknown'}`,
        ));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxResponseBytes) response.destroy(new IntegrationValidationError('invalid_response', 'M-Team response is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', (error) => reject(new IntegrationValidationError('invalid_response', 'Could not read M-Team response', { cause: error })));
    });
    req.on('error', (error) => {
      const reason = signal.aborted && signal.reason instanceof IntegrationValidationError
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
  maxResponseBytes: number,
): Promise<string> {
  return requestBytes(url, address, signal, maxResponseBytes, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body),
      'user-agent': 'MovieHub/1.0',
      'x-api-key': apiKey,
    },
  }, body).then((value) => value.toString('utf8'));
}

async function downloadPublicBytes(
  url: URL,
  signal: AbortSignal,
  maxResponseBytes: number,
  redirectsRemaining: number,
): Promise<Uint8Array> {
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new IntegrationValidationError('invalid_response', 'M-Team redirected to an invalid torrent URL');
  }
  const addresses = await resolvePublicAddresses(url.hostname);
  const address = addresses[0];
  if (!address) throw new IntegrationValidationError('network', 'M-Team torrent hostname did not resolve');
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', signal, family: address.family, lookup: createPinnedLookup(address),
      headers: { accept: 'application/x-bittorrent', 'user-agent': 'MovieHub/1.0' },
    }, (response) => {
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new IntegrationValidationError('invalid_response', 'M-Team torrent download redirected too many times'));
          return;
        }
        let next: URL;
        try { next = new URL(response.headers.location, url); } catch (error) {
          reject(new IntegrationValidationError('invalid_response', 'M-Team returned an invalid torrent redirect', { cause: error }));
          return;
        }
        downloadPublicBytes(next, signal, maxResponseBytes, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new IntegrationValidationError(classifyMTeamHttpFailure(response.statusCode), `M-Team returned HTTP ${response.statusCode ?? 'unknown'}`));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxResponseBytes) response.destroy(new IntegrationValidationError('invalid_response', 'M-Team torrent is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', (error) => reject(new IntegrationValidationError('invalid_response', 'Could not read M-Team torrent', { cause: error })));
    });
    req.on('error', (error) => reject(
      signal.aborted && signal.reason instanceof IntegrationValidationError
        ? signal.reason
        : error instanceof IntegrationValidationError
          ? error
          : new IntegrationValidationError('network', 'Could not download M-Team torrent', { cause: error }),
    ));
    req.end();
  });
}

function requestBytes(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
  maxResponseBytes: number,
  options: { method: string; headers: Record<string, string | number> },
  body?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(url, { ...options, signal, family: address.family, lookup: createPinnedLookup(address) }, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new IntegrationValidationError(classifyMTeamHttpFailure(response.statusCode), `M-Team returned HTTP ${response.statusCode ?? 'unknown'}`));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxResponseBytes) response.destroy(new IntegrationValidationError('invalid_response', 'M-Team response is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', (error) => reject(new IntegrationValidationError('invalid_response', 'Could not read M-Team response', { cause: error })));
    });
    req.on('error', (error) => reject(
      signal.aborted && signal.reason instanceof IntegrationValidationError
        ? signal.reason
        : error instanceof IntegrationValidationError
          ? error
          : new IntegrationValidationError('network', 'Could not connect to M-Team', { cause: error }),
    ));
    req.end(body);
  });
}

export function classifyMTeamHttpFailure(
  statusCode: number | undefined,
): IntegrationValidationError['failureType'] {
  if (statusCode === 401) return 'authentication';
  if (statusCode === 403) return 'permission';
  if (statusCode === 429) return 'rate_limited';
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
  const message = typeof (payload as { message?: unknown }).message === 'string'
    ? (payload as { message: string }).message.toLowerCase()
    : '';
  return /permission|forbidden|權限|权限/.test(message);
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
  const tags = Array.isArray(row.labelsNew)
    ? row.labelsNew.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim())
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
    ...(tags ? { tags } : {}),
  };
}

const resolutionNames: Readonly<Record<string, string>> = {
  '1': '1080p', '2': '1080i', '3': '720p', '5': 'SD', '6': '4K', '7': '8K',
};
const mediumNames: Readonly<Record<string, string>> = {
  '1': 'Blu-ray', '2': 'HD DVD', '3': 'Remux', '4': 'Blu-ray', '5': 'HDTV',
  '6': 'DVD', '7': 'Encode', '8': 'CD', '10': 'WEB',
};
const videoCodecNames: Readonly<Record<string, string>> = {
  '1': 'H.264', '2': 'VC-1', '3': 'Xvid', '4': 'MPEG-2', '16': 'H.265',
  '19': 'AV1', '21': 'VP8/9', '22': 'AVS',
};
const audioCodecNames: Readonly<Record<string, string>> = {
  '1': 'FLAC', '2': 'APE', '3': 'DTS', '4': 'MP2/3', '5': 'OGG', '6': 'AAC',
  '7': 'Other', '8': 'AC3', '9': 'TrueHD', '10': 'TrueHD Atmos', '11': 'DTS-HD MA',
  '12': 'E-AC3', '13': 'E-AC3 Atmos', '14': 'LPCM/PCM', '15': 'WAV',
};

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function describeCode(value: string | undefined, names: Readonly<Record<string, string>>): string | undefined {
  return value ? names[value] ?? value : undefined;
}

function parseNonNegativeInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
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
