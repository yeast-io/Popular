import { AiTrace, withAiTrace } from '../../infrastructure/logging/ai-trace.js';
import { ResourceSiteError } from '../resource-sites/resource-site.errors.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DownloadProvider, DownloadSource } from '@movie-hub/contract';
import type { AuthService } from '../auth/auth.service.js';
import type {
  QBittorrentClientPort,
  QBittorrentConfigStore,
  QBittorrentTorrent,
} from '../integrations/qbittorrent.types.js';
import type {
  TransmissionClientPort,
  TransmissionConfigStore,
  TransmissionTorrent,
} from '../integrations/transmission.types.js';
import type { IntegrationConfigStore } from '../integrations/integration.types.js';
import { IntegrationValidationError, integrationSecretContext } from '../integrations/integration.service.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import { AppError } from '../../infrastructure/http/app-error.js';
import { MovieDownloadService } from './movie-download.service.js';
import type { MovieDownloadRecord, MovieDownloadStore } from './movie-download.types.js';

function fixture(
  providers: DownloadProvider[],
  notifications?: Pick<import('../notifications/notification.service.js').NotificationService, 'reserve' | 'submitted'>
) {
  const ownerId = '507f1f77bcf86cd799439011';
  const enabled = new Set(providers);
  const records = new Map<string, MovieDownloadRecord>();
  const adds: DownloadProvider[] = [];
  const siteFetches: Array<{ owner: string; site: string; id: string }> = [];
  let siteError: Error | undefined;
  const lookups: DownloadProvider[] = [];
  let trFailure = false;
  let trQueryFailure = false;
  let qbQueryFailure = false;
  let trTorrent: TransmissionTorrent | null = null;
  let qbTorrent: QBittorrentTorrent | null = null;
  const secrets = new SecretCrypto('test-integration-secret-key-that-is-long-enough');
  const auth = {
    async requireOwnerId(token?: string) {
      if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      return token === 'other' ? '507f1f77bcf86cd799439099' : ownerId;
    },
  } as unknown as AuthService;
  const qbConfigs = {
    async find(owner: string) {
      return owner === ownerId && enabled.has('qbittorrent')
        ? {
            ownerId,
            baseUrl: 'https://qb.example.com:8080',
            authMethod: 'api_key',
            encryptedCredential: secrets.encrypt(
              JSON.stringify({ authMethod: 'api_key', apiKey: 'private-key' }),
              `movie-hub:integration:qbittorrent:owner:${ownerId}`
            ),
          }
        : null;
    },
  } as QBittorrentConfigStore;
  const trConfigs = {
    async find(owner: string) {
      return owner === ownerId && enabled.has('transmission')
        ? {
            ownerId,
            baseUrl: 'https://tr.example.com:9091',
            username: 'daniel',
            lastFailureType: 'authentication',
            encryptedCredential: secrets.encrypt(
              JSON.stringify({ username: 'daniel', password: 'private-password' }),
              `movie-hub:integration:transmission:owner:${ownerId}`
            ),
          }
        : null;
    },
  } as TransmissionConfigStore;
  const downloads: MovieDownloadStore = {
    async findByRelease(owner, tmdbId, releaseId, source: DownloadSource = 'mteam') {
      return (
        [...records.values()].find((record) => {
          return (
            record.ownerId === owner
            && record.tmdbId === tmdbId
            && record.sourceReleaseId === releaseId
            && record.sourceProvider === source
          );
        }) ?? null
      );
    },
    async createSubmitting(owner, tmdbId, releaseId, provider, source: DownloadSource = 'mteam', downloaderInstanceId?: string, downloaderName?: string) {
      const existing = [...records.values()].find((record) => {
        return (
          record.ownerId === owner
          && record.tmdbId === tmdbId
          && record.sourceReleaseId === releaseId
          && record.sourceProvider === source
        );
      });
      if (existing) return { record: existing, claimed: false };
      const record: MovieDownloadRecord = {
        id: String(records.size + 1),
        ownerId: owner,
        tmdbId,
        sourceProvider: source,
        sourceReleaseId: releaseId,
        provider,
        ...(downloaderInstanceId ? { downloaderInstanceId } : {}),
        ...(downloaderName ? { downloaderName } : {}),
        lookupTag: `tag-${source}-${releaseId}`,
        status: 'submitting',
        progress: 0,
      };
      records.set(record.id, record);
      return { record, claimed: true };
    },
    async retry(id) {
      const current = records.get(id)!;
      if (!['failed', 'missing'].includes(current.status)) return { record: current, claimed: false };
      const record = { ...current, status: 'submitting' as const };
      records.set(id, record);
      return { record, claimed: true };
    },
    async listForMovie(owner, tmdbId) {
      return [...records.values()].filter((record) => {
        return record.ownerId === owner && record.tmdbId === tmdbId;
      });
    },
    async updateProgress(id, progress) {
      const record = { ...records.get(id)!, ...progress };
      delete record.lastErrorCode;
      records.set(id, record);
      return record;
    },
    async markFailed(id, code) {
      const record = { ...records.get(id)!, status: 'failed' as const, lastErrorCode: code };
      records.set(id, record);
      return record;
    },
    async markMissing(id) {
      const record = { ...records.get(id)!, status: 'missing' as const };
      records.set(id, record);
      return record;
    },
  };
  const qb: QBittorrentClientPort = {
    async verify() {
      return { version: '5.2' };
    },
    async addTorrent(_url, _credential, torrentUrl, tag) {
      assert.match(torrentUrl, /^https:\/\/(tracker|hdarea)\.example\/download\.php\?id=991&passkey=private-key$/);
      adds.push('qbittorrent');
      qbTorrent = {
        hash: 'qb-hash',
        name: 'QB Movie',
        state: 'downloading',
        progress: 0.3,
        downloadedBytes: 300,
        totalBytes: 1000,
        downloadSpeed: 10,
        etaSeconds: 70,
        tags: [tag],
      };
    },
    async listTorrents(_url, _credential, hashes) {
      lookups.push('qbittorrent');
      if (qbQueryFailure) throw new IntegrationValidationError('network', 'Offline');
      return qbTorrent && (!hashes?.length || hashes.includes(qbTorrent.hash)) ? [qbTorrent] : [];
    },
    async findByTag(_url, _credential, tag) {
      lookups.push('qbittorrent');
      if (qbQueryFailure) throw new IntegrationValidationError('network', 'Offline');
      return qbTorrent?.tags.includes(tag) ? qbTorrent : null;
    },
  };
  const tr: TransmissionClientPort = {
    async verify() {
      return { version: '4.1' };
    },
    async addTorrent(_url, credential, torrentUrl, tag) {
      assert.match(torrentUrl, /^https:\/\/(tracker|hdarea)\.example\/download\.php\?id=991&passkey=private-key$/);
      assert.equal(credential.password, 'private-password');
      adds.push('transmission');
      if (trFailure) throw new IntegrationValidationError('network', 'Offline');
      trTorrent = {
        hash: 'tr-hash',
        name: 'TR Movie',
        status: 4,
        error: 0,
        progress: 0.4,
        downloadedBytes: 400,
        totalBytes: 1000,
        downloadSpeed: 20,
        etaSeconds: 30,
        labels: [tag],
      };
      return trTorrent.hash;
    },
    async listTorrents(_url, _credential, hashes) {
      lookups.push('transmission');
      if (trQueryFailure) throw new IntegrationValidationError('network', 'Offline');
      return trTorrent && (!hashes?.length || hashes.includes(trTorrent.hash)) ? [trTorrent] : [];
    },
    async findByTag(_url, _credential, tag) {
      lookups.push('transmission');
      if (trQueryFailure) throw new IntegrationValidationError('network', 'Offline');
      return trTorrent?.labels.includes(tag) ? trTorrent : null;
    },
  };
  const service = new MovieDownloadService(
    auth,
    downloads,
    qbConfigs,
    {
      async find() {
        return {
          ownerId,
          provider: 'mteam',
          baseUrl: 'https://mteam.test',
          externalUserId: '101',
          encryptedApiKey: secrets.encrypt('mteam-key', integrationSecretContext(ownerId, 'mteam')),
        };
      },
    } as unknown as IntegrationConfigStore,
    secrets,
    qb,
    {
      async torrentUrl() {
        return 'https://tracker.example/download.php?id=991&passkey=private-key';
      },
    },
    {
      async listReleases() {
        return {
          provider: 'mteam',
          availability: 'available',
          queriedAt: new Date().toISOString(),
          cached: false,
          releases: ['991', '992'].map((id) => {
            return { id, title: 'Movie', detailsUrl: `https://mteam.test/${id}`, seeders: 10, tags: [] };
          }),
        };
      },
    },
    () => new Date('2026-10-17T00:00:00Z'),
    { configs: trConfigs, client: tr },
    notifications,
    {
      resources: {
        async releaseForDownload(owner, movie, site, id) {
          if (owner !== ownerId || movie !== 603 || !['991', '992'].includes(id))
            throw new AppError(404, 'NOT_FOUND', '');
          return {
            id,
            title: 'HDArea Movie',
            seeders: 2,
            tags: [],
            detailsUrl: `https://hdarea.example/details.php?id=${id}`,
          };
        },
      },
      sites: {
        async torrentUrl(owner, site, id) {
          if (siteError) throw siteError;
          siteFetches.push({ owner, site, id });
          return 'https://hdarea.example/download.php?id=991&passkey=private-key';
        },
      },
    }
  );
  return {
    service,
    qbConfigs,
    qb,
    siteFetches,
    setSiteError(error: Error) {
      siteError = error;
    },
    records,
    adds,
    lookups,
    enabled,
    setTrFailure() {
      trFailure = true;
    },
    setTrQueryFailure() {
      trQueryFailure = true;
    },
    setQbQueryFailure() {
      qbQueryFailure = true;
    },
    setTrTorrent(value: TransmissionTorrent | null) {
      trTorrent = value;
    },
    setQbTorrent(value: QBittorrentTorrent | null) {
      qbTorrent = value;
    },
    getQbTorrent() {
      return qbTorrent!;
    },
    getTrTorrent() {
      return trTorrent!;
    },
  };
}

test('lists only owner-configured downloaders including saved configurations with failed validation', async () => {
  const { service } = fixture(['qbittorrent', 'transmission']);
  assert.deepEqual((await service.providers('owner')).providers, [
    { downloaderInstanceId: 'qbittorrent', provider: 'qbittorrent', name: 'qBittorrent' },
    { downloaderInstanceId: 'transmission', provider: 'transmission', name: 'Transmission' },
  ]);
  assert.deepEqual((await service.providers('other')).providers, []);
  await assert.rejects(service.providers(undefined), { code: 'UNAUTHORIZED' });
});

test('automatically selects the sole configured downloader and stores its actual provider', async () => {
  for (const provider of ['qbittorrent', 'transmission'] as const) {
    const { service, adds } = fixture([provider]);
    const result = await service.create('owner', 603, '991');
    assert.equal(result.provider, provider);
    assert.equal(result.progress, provider === 'transmission' ? 40 : 30);
    assert.deepEqual(adds, [provider]);
    assert.equal(JSON.stringify(result).includes('private-'), false);
  }
});

test('recovers a qBittorrent task already added when its submission response is rejected', async () => {
  const f = fixture(['qbittorrent']);
  const originalAdd = f.qb.addTorrent.bind(f.qb);
  f.qb.addTorrent = async (...args) => {
    await originalAdd(...args);
    throw new IntegrationValidationError('invalid_response', 'qBittorrent rejected the torrent');
  };

  const result = await f.service.create('owner', 603, '991');
  assert.equal(result.status, 'downloading');
  assert.equal(result.progress, 30);
  assert.deepEqual(f.adds, ['qbittorrent']);
  assert.deepEqual(f.lookups, ['qbittorrent']);
  assert.equal((await f.service.create('owner', 603, '991')).id, result.id);
  assert.deepEqual(f.adds, ['qbittorrent']);
});

test('two qBittorrent instances require a concrete choice and pin retries to that instance', async () => {
  const f = fixture(['qbittorrent']);
  const original = await f.qbConfigs.find('507f1f77bcf86cd799439011');
  assert.ok(original);
  const first = { ...original, downloaderInstanceId: '00000000-0000-4000-8000-000000000001', name: 'Home', baseUrl: 'https://home.example.com' };
  const second = { ...original, downloaderInstanceId: '00000000-0000-4000-8000-000000000002', name: 'Seedbox', baseUrl: 'https://seedbox.example.com' };
  f.qbConfigs.list = async () => [first, second];
  f.qbConfigs.find = async (_owner, id) => [first, second].find((item) => item.downloaderInstanceId === id) ?? null;
  const submittedUrls: string[] = [];
  const originalAdd = f.qb.addTorrent.bind(f.qb);
  f.qb.addTorrent = async (url, credential, torrentUrl, tag) => {
    submittedUrls.push(url);
    return originalAdd(url, credential, torrentUrl, tag);
  };
  await assert.rejects(f.service.create('owner', 603, '991', 'qbittorrent'), { code: 'DOWNLOAD_PROVIDER_REQUIRED' });
  const submitted = await f.service.create('owner', 603, '991', 'qbittorrent', 'mteam', second.downloaderInstanceId);
  assert.equal(submitted.downloaderInstanceId, second.downloaderInstanceId);
  assert.equal(submitted.downloaderName, 'Seedbox');
  assert.deepEqual(submittedUrls, [second.baseUrl]);
  await assert.rejects(f.service.create('owner', 603, '991', 'qbittorrent', 'mteam', first.downloaderInstanceId), { code: 'DOWNLOAD_PROVIDER_CONFLICT' });
  assert.deepEqual(submittedUrls, [second.baseUrl]);
});

test('requires selection with multiple downloaders and rejects absent configurations before submission', async () => {
  const both = fixture(['qbittorrent', 'transmission']);
  await assert.rejects(both.service.create('owner', 603, '991'), { code: 'DOWNLOAD_PROVIDER_REQUIRED' });
  assert.deepEqual(both.adds, []);
  for (const provider of ['qbittorrent', 'transmission'] as const) {
    const selected = fixture(['qbittorrent', 'transmission']);
    assert.equal((await selected.service.create('owner', 603, '991', provider)).provider, provider);
    assert.deepEqual(selected.adds, [provider]);
  }
  const none = fixture([]);
  await assert.rejects(none.service.create('owner', 603, '991'), { code: 'DOWNLOAD_NOT_CONFIGURED' });
  await assert.rejects(none.service.create('owner', 603, '991', 'transmission'), {
    code: 'DOWNLOAD_NOT_CONFIGURED',
  }
  );
  await assert.rejects(none.service.create('owner', 603, '991', 'qbittorrent'), { code: 'DOWNLOAD_NOT_CONFIGURED' });
});

test('never falls back to the other downloader after a failed submission', async () => {
  const { service, adds, records, setTrFailure } = fixture(['qbittorrent', 'transmission']);
  setTrFailure();
  await assert.rejects(service.create('owner', 603, '991', 'transmission'), { code: 'TRANSMISSION_UNREACHABLE' });
  assert.deepEqual(adds, ['transmission']);
  assert.equal([...records.values()][0]?.provider, 'transmission');
  assert.equal([...records.values()][0]?.status, 'failed');
});

test('concurrent submissions share one release claim and cannot change an existing task provider', async () => {
  const { service, adds } = fixture(['qbittorrent', 'transmission']);
  const results = await Promise.all([
    service.create('owner', 603, '991', 'transmission'),
    service.create('owner', 603, '991', 'transmission'),
  ]
  );
  assert.equal(results[0]?.id, results[1]?.id);
  assert.deepEqual(adds, ['transmission']);
  await assert.rejects(service.create('owner', 603, '991', 'qbittorrent'), { code: 'DOWNLOAD_PROVIDER_CONFLICT' });
});

test('syncs each provider independently and preserves a failed provider snapshot', async () => {
  const f = fixture(['qbittorrent', 'transmission']);
  await f.service.create('owner', 603, '991', 'qbittorrent');
  await f.service.create('owner', 603, '992', 'transmission');
  f.setTrTorrent({ ...f.getTrTorrent(), progress: 1, status: 6 });
  f.setQbQueryFailure();
  f.lookups.length = 0;
  const result = await f.service.listAndSync('owner', 603);
  assert.equal(result.items.find((item) => item.provider === 'qbittorrent')?.progress, 30);
  assert.equal(result.items.find((item) => item.provider === 'transmission')?.status, 'seeding');
  assert.deepEqual(f.lookups, ['qbittorrent', 'transmission']);
});

test('maps Transmission paused, completed, downloading, queued-seeding and error states', async () => {
  for (const [status, progress, error, expected] of [
    [0, 0.2, 0, 'paused'],
    [4, 0.4, 0, 'downloading'],
    [0, 1, 0, 'completed'],
    [5, 1, 0, 'seeding'],
    [4, 0.4, 2, 'failed'],
  ] as const) {
    const f = fixture(['transmission']);
    await f.service.create('owner', 603, '991');
    f.setTrTorrent({ ...f.getTrTorrent(), status, progress, error });
    assert.equal((await f.service.listAndSync('owner', 603)).items[0]?.status, expected);
  }
});

test('recovers Transmission by label or hash, marks missing tasks and blocks retries during outages', async () => {
  const f = fixture(['transmission']);
  await f.service.create('owner', 603, '991');
  const record = [...f.records.values()][0]!;
  const { torrentHash: _hash, ...withoutHash } = record;
  f.records.set(record.id, { ...withoutHash, status: 'failed' });
  const recovered = await f.service.create('owner', 603, '991');
  assert.equal(recovered.status, 'downloading');
  assert.deepEqual(f.adds, ['transmission']);
  f.setTrTorrent(null);
  assert.equal((await f.service.listAndSync('owner', 603)).items[0]?.status, 'missing');
  f.setTrQueryFailure();
  await assert.rejects(f.service.create('owner', 603, '991'), { code: 'TRANSMISSION_UNREACHABLE' });
  assert.deepEqual(f.adds, ['transmission']);
});

test('download routes authenticate provider discovery, validate choices and serialize the actual provider', async () => {
  const { buildApp } = await import('../../app.js');
  const { loadConfig } = await import('../../config/env.js');
  const config = loadConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:5173',
    MONGODB_URI: 'mongodb://db.example/movie_hub',
    REDIS_URL: 'redis://redis.example:6379',
    MINIO_ENDPOINT: 'minio.example',
    MINIO_ACCESS_KEY: 'access',
    MINIO_SECRET_KEY: 'secret',
    MINIO_BUCKET: 'avatars',
    SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
    INTEGRATION_SECRET_KEY: 'test-integration-secret-key-at-least-32-characters',
    TMDB_READ_ACCESS_TOKEN: 'test-token',
    ACCESS_LOG_ENABLED: 'false',
  }
  );
  const { service, adds } = fixture(['qbittorrent', 'transmission']);
  const app = await buildApp({ config, healthDependencies: [], movieDownloadService: service });
  const headers = { cookie: `${config.SESSION_COOKIE_NAME}=owner` };
  const url = '/api/v1/me/movies/603/downloads';
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/me/download-providers' })).statusCode, 401);
    const providers = await app.inject({ method: 'GET', url: '/api/v1/me/download-providers', headers });
    assert.deepEqual(providers.json(), { providers: [
      { downloaderInstanceId: 'qbittorrent', provider: 'qbittorrent', name: 'qBittorrent' },
      { downloaderInstanceId: 'transmission', provider: 'transmission', name: 'Transmission' },
    ] });
    const missing = await app.inject({ method: 'POST', url, headers, payload: { sourceReleaseId: '991' } });
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json().error.code, 'DOWNLOAD_PROVIDER_REQUIRED');
    const invalid = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { sourceReleaseId: '991', provider: 'invalid' },
    }
    );
    assert.equal(invalid.statusCode, 400);
    const other = await app.inject({
      method: 'POST',
      url,
      headers: { cookie: `${config.SESSION_COOKIE_NAME}=other` },
      payload: { sourceReleaseId: '991', provider: 'transmission' },
    }
    );
    assert.equal(other.statusCode, 409);
    assert.deepEqual(adds, []);
    const created = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { sourceReleaseId: '991', provider: 'transmission' },
    }
    );
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().provider, 'transmission');
    assert.equal(created.body.includes('private-'), false);
    const hdarea = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { sourceReleaseId: '991', provider: 'qbittorrent', sourceProvider: 'hdarea' },
    }
    );
    assert.equal(hdarea.statusCode, 201);
    assert.equal(hdarea.json().sourceProvider, 'hdarea');
    assert.notEqual(hdarea.json().id, created.json().id);
    assert.equal(/passkey|download\.php|cookie/i.test(hdarea.body), false);
    const listing = await app.inject({ method: 'GET', url, headers });
    assert.equal(listing.json().items[0].provider, 'transmission');
  } finally {
    await app.close();
  }
});

test('reserves recovery state before remote add and activates scanning only after successful creation', async () => {
  for (const provider of ['qbittorrent', 'transmission'] as const) {
    const calls: string[] = [];
    const f = fixture([provider], {
      reserve: async (owner, id) => {
        assert.equal(f.adds.length, 0);
        assert.equal(f.records.get(id)?.ownerId, owner);
        calls.push('reserved');
      },
      submitted: async (owner, id) => {
        assert.deepEqual(f.adds, [provider]);
        assert.equal(f.records.get(id)?.ownerId, owner);
        calls.push('activated');
      },
    }
    );
    await f.service.create('owner', 603, '991');
    await f.service.create('owner', 603, '991');
    assert.deepEqual(calls, ['reserved', 'activated']);
  }
  let activated = false;
  const failing = fixture(['transmission'], {
    reserve: async () => undefined,
    submitted: async () => {
      activated = true;
    },
  }
  );
  failing.setTrFailure();
  await assert.rejects(() => failing.service.create('owner', 603, '991'));
  assert.equal(activated, false);
});

test('failure to persist notification intent fails safely before submitting and permits retry', async () => {
  let fail = true;
  const f = fixture(['transmission'], {
    reserve: async () => {
      if (fail) throw new Error('database unavailable');
    },
    submitted: async () => {
      return undefined;
    },
  }
  );
  await assert.rejects(() => f.service.create('owner', 603, '991'), /database unavailable/);
  assert.equal(f.adds.length, 0);
  assert.equal([...f.records.values()][0]?.status, 'failed');
  fail = false;
  await f.service.create('owner', 603, '991');
  assert.deepEqual(f.adds, ['transmission']);
});

test('trusted owner download entry reuses the existing claim and does not require an HTTP token', async () => {
  const { service, adds } = fixture(['transmission']);
  const ownerId = '507f1f77bcf86cd799439011';
  assert.deepEqual(await service.providersFor(ownerId), ['transmission']);
  const first = await service.createForOwner(ownerId, 603, '991', 'transmission');
  const replay = await service.createForOwner(ownerId, 603, '991', 'transmission');
  assert.equal(first.id, replay.id);
  assert.deepEqual(adds, ['transmission']);
  await assert.rejects(service.create(undefined, 603, '991'), { code: 'UNAUTHORIZED' });
  await assert.rejects(service.createForOwner('507f1f77bcf86cd799439099', 603, '991', 'transmission'), {
    code: 'DOWNLOAD_NOT_CONFIGURED',
  }
  );
});

test('the account default applies without a selection; explicit choice and pinned retries take precedence', async () => {
  const f = fixture(['qbittorrent', 'transmission']);
  let primary = 'transmission';
  let defaultReads = 0;
  f.service.preferences = {
    async get() {
      defaultReads += 1;
      return { defaults: { downloader: primary }, selectedSites: [], effectiveSites: [], choices: [] };
    },
  };
  assert.equal((await f.service.create('owner', 603, '991')).provider, 'transmission');
  primary = 'qbittorrent';
  assert.equal((await f.service.create('owner', 603, '991')).provider, 'transmission');
  assert.equal((await f.service.create('owner', 603, '992', 'transmission')).provider, 'transmission');
  assert.deepEqual(f.adds, ['transmission', 'transmission']);
  assert.equal(defaultReads, 1);
});

test('missing qBittorrent tasks recover without duplicates or re-add only after an explicit download request', async () => {
  const f = fixture(['qbittorrent']);
  await f.service.create('owner', 603, '991');
  const torrent = f.getQbTorrent();
  f.setQbTorrent(null);
  assert.equal((await f.service.listAndSync('owner', 603)).items[0]?.status, 'missing');
  assert.deepEqual(f.adds, ['qbittorrent']);
  f.setQbTorrent(torrent);
  assert.equal((await f.service.create('owner', 603, '991')).status, 'downloading');
  assert.deepEqual(f.adds, ['qbittorrent']);
  f.setQbTorrent(null);
  await f.service.listAndSync('owner', 603);
  await f.service.create('owner', 603, '991');
  assert.deepEqual(f.adds, ['qbittorrent', 'qbittorrent']);
});

test('HDArea downloads submit server-generated torrent URLs and isolate the same release ID from M-Team', async () => {
  const f = fixture(['qbittorrent', 'transmission']);
  const hd = await f.service.create('owner', 603, '991', 'transmission', 'hdarea');
  assert.equal(hd.sourceProvider, 'hdarea');
  assert.equal(hd.provider, 'transmission');
  assert.deepEqual(f.siteFetches, [{ owner: '507f1f77bcf86cd799439011', site: 'hdarea', id: '991' }]);
  const mt = await f.service.create('owner', 603, '991', 'qbittorrent');
  assert.notEqual(mt.id, hd.id);
  assert.equal(f.records.size, 2);
  assert.equal(mt.sourceProvider, 'mteam');
  assert.equal((await f.service.create('owner', 603, '991', 'transmission', 'hdarea')).id, hd.id);
  assert.equal(f.siteFetches.length, 1);
  await assert.rejects(f.service.create('other', 603, '991', 'transmission', 'hdarea'));
  assert.equal(f.siteFetches.length, 1);
});

test('HDArea missing task redownload uses its original source and downloader', async () => {
  const f = fixture(['transmission']);
  await f.service.create('owner', 603, '991', undefined, 'hdarea');
  f.setTrTorrent(null);
  assert.equal((await f.service.listAndSync('owner', 603)).items[0]?.status, 'missing');
  await f.service.create('owner', 603, '991', undefined, 'hdarea');
  assert.equal(f.siteFetches.length, 2);
  assert.deepEqual(f.adds, ['transmission', 'transmission']);
});

for (const provider of ['qbittorrent', 'transmission'] as const) {
  test(`HDArea submits with the sole ${provider} downloader and returns no credential-bearing fields`, async () => {
    const f = fixture([provider]);
    const response = await f.service.create('owner', 603, '991', undefined, 'hdarea');
    assert.equal(response.sourceProvider, 'hdarea');
    assert.equal(response.provider, provider);
    assert.deepEqual(f.adds, [provider]);
    assert.equal(/passkey|torrentUrl|download\.php|cookie/i.test(JSON.stringify(response)), false);
  });
}

test('a missing HDArea Passkey does not submit to a downloader or fall back to M-Team', async () => {
  const f = fixture(['qbittorrent', 'transmission']);
  f.setSiteError(new ResourceSiteError('passkeyRequired'));
  await assert.rejects(f.service.create('owner', 603, '991', 'qbittorrent', 'hdarea'), (error) => {
    return error instanceof ResourceSiteError && error.reason === 'passkeyRequired';
  });
  assert.deepEqual(f.adds, []);
  assert.equal([...f.records.values()][0]?.sourceProvider, 'hdarea');
  assert.equal([...f.records.values()][0]?.status, 'failed');
});

test('accepted URL submissions remain submitting until the downloader task can be inspected', async () => {
  for (const provider of ['qbittorrent', 'transmission'] as const) {
    const f = fixture([provider]);
    if (provider === 'qbittorrent') f.setQbQueryFailure();
    else f.setTrQueryFailure();
    const result = await f.service.create('owner', 603, '991');
    assert.equal(result.status, 'submitting');
    await f.service.create('owner', 603, '991');
    assert.deepEqual(f.adds, [provider]);
  }
});

test('resolved torrent URLs are redacted from failure causes and never persisted', async () => {
  for (const source of ['mteam', 'hdarea'] as const) {
    const url = `https://${source === 'mteam' ? 'tracker' : 'hdarea'}.example/download.php?id=991&passkey=private-key`;
    const logs: unknown[] = [];
    const f = fixture(['transmission'], {
      async reserve() {
        throw new Error('Submission preparation failed', { cause: new Error(url) });
      },
      async submitted() {},
    }
    );
    const trace = new AiTrace(
      {
        error: (...args: unknown[]) => {
          logs.push(args);
        },
      },
      {},
      '',
      'download.create',
      false
    );
    await withAiTrace(trace, async () => {
      try {
        await f.service.create('owner', 603, '991', undefined, source);
        assert.fail('expected submission preparation failure');
      } catch (error) {
        trace.fail(error);
      }
    });
    assert.equal(logs.length, 1);
    assert.equal(JSON.stringify(logs).includes(url), false);
    assert.equal(JSON.stringify(logs).includes('private-key'), false);
    assert.equal(JSON.stringify([...f.records.values()]).includes(url), false);
    assert.equal(JSON.stringify([...f.records.values()]).includes('private-key'), false);
    assert.deepEqual(f.adds, []);
  }
});

test('remote original records never retry or query a local downloader, and notification inspection uses persisted progress', async () => {
  const f = fixture(['qbittorrent', 'transmission']);
  const remote: MovieDownloadRecord = {
    id: 'remote-original',
    ownerId: '507f1f77bcf86cd799439011',
    tmdbId: 603,
    sourceProvider: 'mteam',
    sourceReleaseId: '991',
    provider: 'qbittorrent',
    lookupTag: 'remote',
    executionMode: 'remote',
    status: 'failed',
    progress: 50,
    torrentHash: 'a'.repeat(40),
  };
  f.records.set(remote.id, remote);
  await f.service.create('owner', 603, '991', 'qbittorrent', 'mteam');
  await f.service.listAndSync('owner', 603);
  assert.equal(f.adds.length, 0);
  assert.equal(f.lookups.length, 0);
  const completed = { ...remote, status: 'completed' as const, progress: 100 };
  assert.equal((await f.service.inspect(completed))!.progress, 100);
  assert.equal(f.lookups.length, 0);
});
