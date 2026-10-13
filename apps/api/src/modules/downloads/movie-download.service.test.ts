import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthService } from '../auth/auth.service.js';
import type { IntegrationConfigStore } from '../integrations/integration.types.js';
import { integrationSecretContext } from '../integrations/integration.service.js';
import type { MovieResourceCheckService } from '../integrations/movie-resource-check.service.js';
import type { QBittorrentClientPort, QBittorrentConfigStore } from '../integrations/qbittorrent.types.js';
import { SecretCrypto } from '../integrations/secret-crypto.js';
import type { MovieDownloadProgress, MovieDownloadRecord, MovieDownloadStore } from './movie-download.types.js';
import { MovieDownloadService } from './movie-download.service.js';

test('recovers a previously misclassified failed download by its qBittorrent tag', async () => {
  const ownerId = '507f1f77bcf86cd799439011';
  const now = new Date('2026-10-13T06:00:00Z');
  const secrets = new SecretCrypto('test-integration-secret-key-that-is-long-enough');
  const failed: MovieDownloadRecord = {
    id: '507f1f77bcf86cd799439012', ownerId, tmdbId: 123, sourceProvider: 'mteam',
    sourceReleaseId: 'release-1', provider: 'qbittorrent', lookupTag: 'movie-hub-existing',
    status: 'failed', progress: 0, lastErrorCode: 'MOVIE_DOWNLOAD_FAILED',
  };
  const updates: MovieDownloadRecord[] = [];
  const downloads = {
    async findByRelease() { return failed; },
    async updateProgress(_id: string, progress: MovieDownloadProgress) {
      const updated = { ...failed, ...progress };
      updates.push(updated);
      return updated;
    },
  } as unknown as MovieDownloadStore;
  const qbittorrentConfigs = {
    async find() {
      return {
        ownerId, baseUrl: 'http://qbittorrent:8080', authMethod: 'api_key' as const,
        encryptedCredential: secrets.encrypt(
          JSON.stringify({ authMethod: 'api_key', apiKey: 'secret' }),
          `movie-hub:integration:qbittorrent:owner:${ownerId}`,
        ),
      };
    },
  } as unknown as QBittorrentConfigStore;
  const mteamConfigs = {
    async find() {
      return {
        ownerId, provider: 'mteam' as const, baseUrl: 'https://m-team.test',
        encryptedApiKey: secrets.encrypt('mteam-key', integrationSecretContext(ownerId, 'mteam')),
      };
    },
  } as unknown as IntegrationConfigStore;
  let addCalls = 0;
  const qbittorrent = {
    async findByTag() {
      return {
        hash: 'ABC123', name: 'Movie', state: 'downloading', progress: 0.4,
        downloadedBytes: 400, totalBytes: 1_000, downloadSpeed: 20, etaSeconds: 30,
        tags: ['movie-hub-existing'],
      };
    },
    async addTorrent() { addCalls += 1; },
  } as unknown as QBittorrentClientPort;
  const auth = { requireOwnerId: async () => ownerId } as unknown as AuthService;
  const resources = {
    async listReleases() { throw new Error('recovery should not reload releases'); },
  } as unknown as Pick<MovieResourceCheckService, 'listReleases'>;
  const service = new MovieDownloadService(
    auth,
    downloads,
    qbittorrentConfigs,
    mteamConfigs,
    secrets,
    qbittorrent,
    { downloadTorrent: async () => { throw new Error('recovery should not download the torrent again'); } },
    resources,
    () => now,
  );

  const result = await service.create('session', 123, 'release-1');

  assert.equal(addCalls, 0);
  assert.equal(result.status, 'downloading');
  assert.equal(result.progress, 40);
  assert.equal(updates[0]?.torrentHash, 'ABC123');
});

test('recovers a failed download while syncing an open release dialog', async () => {
  const ownerId = '507f1f77bcf86cd799439011';
  const now = new Date('2026-10-13T06:00:00Z');
  const secrets = new SecretCrypto('test-integration-secret-key-that-is-long-enough');
  const failed: MovieDownloadRecord = {
    id: '507f1f77bcf86cd799439012', ownerId, tmdbId: 123, sourceProvider: 'mteam',
    sourceReleaseId: 'release-1', provider: 'qbittorrent', lookupTag: 'movie-hub-existing',
    status: 'failed', progress: 0, lastErrorCode: 'MOVIE_DOWNLOAD_FAILED',
  };
  let current = failed;
  const downloads = {
    async listForMovie() { return [current]; },
    async updateProgress(_id: string, progress: MovieDownloadProgress) {
      const { lastErrorCode: _lastErrorCode, ...withoutError } = current;
      current = { ...withoutError, ...progress };
      return current;
    },
  } as unknown as MovieDownloadStore;
  const qbittorrentConfigs = {
    async find() {
      return {
        ownerId, baseUrl: 'http://qbittorrent:8080', authMethod: 'api_key' as const,
        encryptedCredential: secrets.encrypt(
          JSON.stringify({ authMethod: 'api_key', apiKey: 'secret' }),
          `movie-hub:integration:qbittorrent:owner:${ownerId}`,
        ),
      };
    },
  } as unknown as QBittorrentConfigStore;
  const qbittorrent = {
    async findByTag() {
      return {
        hash: 'ABC123', name: 'Movie', state: 'uploading', progress: 1,
        downloadedBytes: 1_000, totalBytes: 1_000, downloadSpeed: 0, etaSeconds: 0,
        tags: ['movie-hub-existing'],
      };
    },
  } as unknown as QBittorrentClientPort;
  const service = new MovieDownloadService(
    { requireOwnerId: async () => ownerId } as unknown as AuthService,
    downloads,
    qbittorrentConfigs,
    { find: async () => null } as unknown as IntegrationConfigStore,
    secrets,
    qbittorrent,
    { downloadTorrent: async () => new Uint8Array() },
    { listReleases: async () => { throw new Error('not used'); } } as unknown as Pick<MovieResourceCheckService, 'listReleases'>,
    () => now,
  );

  const result = await service.listAndSync('session', 123);

  assert.equal(result.items[0]?.status, 'seeding');
  assert.equal(result.items[0]?.progress, 100);
  assert.equal(result.items[0]?.lastErrorCode, undefined);
});
