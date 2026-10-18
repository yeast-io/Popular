import { IntegrationValidationError } from '../../modules/integrations/integration.service.js';
import type { TransmissionClientPort, TransmissionCredential, TransmissionTorrent } from '../../modules/integrations/transmission.types.js';

export class TransmissionClient implements TransmissionClientPort {
  constructor(
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async verify(baseUrl: string, credential: TransmissionCredential): Promise<{ version: string }> {
    const args = await this.rpc(baseUrl, credential, 'session-get', { fields: ['version'] });
    const version = args.version;
    if (typeof version !== 'string' || !version.trim() || version.length > 100) throw invalidResponse();
    return { version: version.trim() };
  }

  async addTorrent(baseUrl: string, credential: TransmissionCredential, torrent: Uint8Array, tag: string): Promise<string> {
    const args = await this.rpc(baseUrl, credential, 'torrent-add', {
      metainfo: Buffer.from(torrent).toString('base64'), labels: [tag], paused: false,
    });
    // Duplicate adds are successful too; keep the returned hash so tracking never depends on relabeling an existing torrent.
    const added = args['torrent-added'] ?? args.torrent_added ?? args['torrent-duplicate'] ?? args.torrent_duplicate;
    if (!isObject(added)) throw invalidResponse();
    const hash = added.hashString ?? added.hash_string;
    if (typeof hash !== 'string' || !hash.trim()) throw invalidResponse();
    return hash.toLowerCase();
  }

  async listTorrents(baseUrl: string, credential: TransmissionCredential, hashes: string[] = []): Promise<TransmissionTorrent[]> {
    const args = await this.rpc(baseUrl, credential, 'torrent-get', {
      fields: ['hashString', 'name', 'status', 'error', 'percentDone', 'downloadedEver', 'sizeWhenDone', 'rateDownload', 'eta', 'labels'],
      ...(hashes.length ? { ids: hashes } : {}),
    });
    if (!Array.isArray(args.torrents)) throw invalidResponse();
    return args.torrents.map(parseTorrent);
  }

  async findByTag(baseUrl: string, credential: TransmissionCredential, tag: string): Promise<TransmissionTorrent | null> {
    return (await this.listTorrents(baseUrl, credential)).find(torrent => torrent.labels.includes(tag)) ?? null;
  }

  private async rpc(baseUrl: string, credential: TransmissionCredential, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const headers = new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`,
    });
    let modern = false;
    try {
      // Session IDs stay local to this operation, avoiding cross-account reuse.
      for (let attempt = 0; attempt < 2; attempt++) {
        const body = modern
          ? { jsonrpc: '2.0', method: method.replaceAll('-', '_'), params: modernArguments(args), id: 1 }
          : { method, arguments: args, tag: 1 };
        const response = await this.fetchImpl(`${baseUrl}/transmission/rpc`, {
          method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal,
        });
        if (response.status === 409) {
          const sessionId = response.headers.get('x-transmission-session-id');
          const rpcVersion = response.headers.get('x-transmission-rpc-version');
          await response.body?.cancel();
          if (attempt !== 0 || !sessionId) throw invalidResponse();
          headers.set('x-transmission-session-id', sessionId);
          modern = Number.parseInt(rpcVersion ?? '0', 10) >= 6;
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new IntegrationValidationError('authentication', 'Transmission rejected authentication or RPC access');
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new IntegrationValidationError('remote_error', 'Transmission returned an unsuccessful HTTP response');
        }
        let payload: unknown;
        try { payload = await response.json(); } catch {
          if (signal.aborted) throw new IntegrationValidationError('timeout', 'Transmission request timed out');
          throw invalidResponse();
        }
        if (!isObject(payload)) throw invalidResponse();
        const result = modern ? payload.result : payload.arguments;
        if (modern ? payload.jsonrpc !== '2.0' || payload.id !== 1 || payload.error !== undefined : payload.result !== 'success' || payload.tag !== 1) {
          throw invalidResponse();
        }
        if (!isObject(result)) throw invalidResponse();
        return result;
      }
      throw invalidResponse();
    } catch (error) {
      if (error instanceof IntegrationValidationError) throw error;
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new IntegrationValidationError('timeout', 'Transmission request timed out');
      }
      throw new IntegrationValidationError('network', 'Could not connect to Transmission');
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidResponse(): IntegrationValidationError {
  return new IntegrationValidationError('invalid_response', 'Transmission returned an invalid RPC response');
}

const modernFields: Record<string, string> = {
  hashString: 'hash_string', percentDone: 'percent_done', downloadedEver: 'downloaded_ever',
  sizeWhenDone: 'size_when_done', rateDownload: 'rate_download',
};

function modernArguments(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args, ...(Array.isArray(args.fields) ? { fields: args.fields.map(field => modernFields[String(field)] ?? field) } : {}) };
}

function parseTorrent(value: unknown): TransmissionTorrent {
  if (!isObject(value)) throw invalidResponse();
  const hash = value.hashString ?? value.hash_string;
  const progress = value.percentDone ?? value.percent_done;
  if (typeof hash !== 'string' || !hash || typeof value.name !== 'string' || !value.name
      || typeof value.status !== 'number' || !Number.isInteger(value.status) || value.status < 0 || value.status > 6
      || typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1
      || typeof value.error !== 'number' || !Number.isInteger(value.error) || value.error < 0) throw invalidResponse();
  return {
    hash: hash.toLowerCase(), name: value.name, status: value.status, error: value.error, progress,
    downloadedBytes: nonNegative(value.downloadedEver ?? value.downloaded_ever),
    totalBytes: nonNegative(value.sizeWhenDone ?? value.size_when_done),
    downloadSpeed: nonNegative(value.rateDownload ?? value.rate_download),
    etaSeconds: nonNegative(value.eta),
    labels: Array.isArray(value.labels) ? value.labels.filter((label): label is string => typeof label === 'string') : [],
  };
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
