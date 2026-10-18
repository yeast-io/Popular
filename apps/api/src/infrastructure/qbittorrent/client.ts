import { IntegrationValidationError } from '../../modules/integrations/integration.service.js';
import type {
  QBittorrentClientPort,
  QBittorrentCredential,
  QBittorrentTorrent,
} from '../../modules/integrations/qbittorrent.types.js';

type FetchLike = typeof fetch;

export class QBittorrentClient implements QBittorrentClientPort {
  constructor(
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch
  )
  {
  }

  async verify(baseUrl: string, credential: QBittorrentCredential): Promise<{ version: string }> {
    const response = await this.request(baseUrl, credential, 'app/version');
    const version = (await response.text()).trim();
    if (!version || version.length > 100) throw invalidResponse('qBittorrent returned an invalid version');
    return { version };
  }

  async addTorrent(
    baseUrl: string,
    credential: QBittorrentCredential,
    torrent: Uint8Array,
    tag: string,
  ): Promise<void> {
    const body = new FormData();
    body.append('torrents', new Blob([torrent], { type: 'application/x-bittorrent' }), 'movie.torrent');
    body.append('category', 'movie-hub');
    body.append('tags', tag);
    const response = await this.request(baseUrl, credential, 'torrents/add', { method: 'POST', body });
    const result = (await response.text()).trim();
    if (!isSuccessfulAddResponse(result)) throw invalidResponse('qBittorrent rejected the torrent');
  }

  async listTorrents(
    baseUrl: string,
    credential: QBittorrentCredential,
    hashes: string[] = [],
  ): Promise<QBittorrentTorrent[]> {
    const query = hashes.length ? `?hashes=${encodeURIComponent(hashes.join('|'))}` : '';
    return this.readTorrents(await this.request(baseUrl, credential, `torrents/info${query}`));
  }

  async findByTag(baseUrl: string, credential: QBittorrentCredential, tag: string): Promise<QBittorrentTorrent | null> {
    const rows = await this.readTorrents(
      await this.request(baseUrl, credential, `torrents/info?tag=${encodeURIComponent(tag)}`),
    );
    return rows[0] ?? null;
  }

  private async readTorrents(response: Response): Promise<QBittorrentTorrent[]> {
    let payload: unknown;
    try { payload = await response.json(); } catch (error) {
      throw new IntegrationValidationError('invalid_response', 'qBittorrent returned invalid JSON', { cause: error });
    }
    if (!Array.isArray(payload)) throw invalidResponse('qBittorrent returned an invalid torrent list');
    return payload.map(parseTorrent);
  }

  private async request(
    baseUrl: string,
    credential: QBittorrentCredential,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json, text/plain');
    headers.set('origin', new URL(baseUrl).origin);
    headers.set('referer', `${baseUrl}/`);
    if (credential.authMethod === 'api_key') {
      headers.set('authorization', `Bearer ${credential.apiKey}`);
    } else {
      headers.set('cookie', await this.login(baseUrl, credential));
    }
    return this.fetchChecked(`${baseUrl}/api/v2/${path}`, { ...init, headers });
  }

  private async login(
    baseUrl: string,
    credential: Extract<QBittorrentCredential, { authMethod: 'username_password' }>,
  ): Promise<string> {
    const body = new URLSearchParams({ username: credential.username, password: credential.password });
    const response = await this.fetchChecked(`${baseUrl}/api/v2/auth/login`, {
      method: 'POST',
      headers: {
        accept: 'text/plain',
        'content-type': 'application/x-www-form-urlencoded',
        origin: new URL(baseUrl).origin,
      },
      body,
    }, true);
    const result = (await response.text()).trim();
    const sid = response.headers.get('set-cookie')?.match(/(?:^|;\s*)SID=([^;]+)/)?.[1];
    if (result !== 'Ok.' || !sid) throw new IntegrationValidationError('authentication', 'qBittorrent rejected the credentials');
    return `SID=${sid}`;
  }

  private async fetchChecked(url: string, init: RequestInit, login = false): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new IntegrationValidationError('timeout', 'qBittorrent request timed out', { cause: error });
      }
      throw new IntegrationValidationError('network', 'Could not connect to qBittorrent', { cause: error });
    }
    if (response.status === 401 || response.status === 403) {
      throw new IntegrationValidationError('authentication', 'qBittorrent rejected the credentials');
    }
    if (!response.ok) {
      throw new IntegrationValidationError('remote_error', `qBittorrent returned HTTP ${response.status}`);
    }
    if (login && response.status !== 200) throw new IntegrationValidationError('authentication', 'qBittorrent login failed');
    return response;
  }
}

function parseTorrent(value: unknown): QBittorrentTorrent {
  if (!value || typeof value !== 'object') throw invalidResponse('qBittorrent returned an invalid torrent');
  const row = value as Record<string, unknown>;
  const hash = readString(row.hash);
  const name = readString(row.name);
  const state = readString(row.state);
  if (!hash || !name || !state) throw invalidResponse('qBittorrent returned an incomplete torrent');
  const progress = readNumber(row.progress, 0, 1);
  return {
    hash,
    name,
    state,
    progress,
    downloadedBytes: readInteger(row.downloaded),
    totalBytes: readInteger(row.total_size ?? row.size),
    downloadSpeed: readInteger(row.dlspeed),
    etaSeconds: readInteger(row.eta),
    tags: typeof row.tags === 'string' ? row.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : 0;
}

function readInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function invalidResponse(message: string): IntegrationValidationError {
  return new IntegrationValidationError('invalid_response', message);
}

function isSuccessfulAddResponse(value: string): boolean {
  if (value === 'Ok.') return true;

  try {
    const payload = JSON.parse(value) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const result = payload as Record<string, unknown>;
    return typeof result.success_count === 'number'
      && Number.isSafeInteger(result.success_count)
      && result.success_count > 0;
  } catch {
    return false;
  }
}
