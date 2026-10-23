import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationService } from './notification.service.js';
import { NotificationWorker, buildDownloadNotification } from './notification.worker.js';
import { CHECK_INTERVAL_MS } from './notification.policy.js';
import type {
  ClaimedDownload,
  NotificationChannel,
  NotificationPlan,
  NotificationPreferenceRecord,
  NotificationStore,
  NotificationLocaleOptions,
  DownloadNotification,
} from './notification.types.js';
import type { MovieDownloadProgress } from '../downloads/movie-download.types.js';
import { AppError } from '../../infrastructure/http/app-error.js';

test('completion notification labels the concrete downloader instance', async () => {
  const notification = await buildDownloadNotification({
    id: 'download-1', ownerId: 'owner-1', tmdbId: 7, provider: 'qbittorrent',
    downloaderInstanceId: '00000000-0000-4000-8000-000000000001', downloaderName: 'Seedbox',
    sourceProvider: 'mteam', sourceReleaseId: 'release', lookupTag: 'tag', status: 'completed', progress: 100,
  }, 'notification-1', new Date(), { readMovies: async () => [] }, 'en-US', 'https://popular.example.com');
  assert.equal(notification.provider, 'Seedbox');
});

function fixture(localeOptions: NotificationLocaleOptions = {}) {
  let time = Date.now();
  const now = () => new Date(time);
  const preferences = new Map<string, NotificationPreferenceRecord>();
  const tasks: ClaimedDownload[] = [];
  const plans: Array<{ owner: string; id: string; plan: NotificationPlan }> = [];
  const sent: string[] = [];
  const payloads: DownloadNotification[] = [];
  const readLocales: string[] = [];
  const checked: string[] = [];
  let failSecond = true;
  const defaults = () => {
    return { enabled: false, defaultChannel: 'whatsapp', additionalChannels: [], epoch: 0 };
  };
  const store: NotificationStore = {
    preferences: async (owner) => preferences.get(owner) ?? defaults(),
    savePreferences: async (owner, input) => {
      const previous = preferences.get(owner) ?? defaults();
      const saved = { ...input, epoch: previous.epoch + (input.enabled ? 0 : 1) };
      preferences.set(owner, saved);
      return saved;
    },
    cancelOwner: async (owner, epoch) => {
      tasks
        .filter((item) => item.record.ownerId === owner && item.task.epoch < epoch)
        .forEach((item) => {
          item.task.cancelled = true;
        });
    },
    reserve: async (owner, id, plan) => {
      plans.push({ owner, id, plan });
    },
    activate: async (owner, id) => {
      const intent = plans.find((item) => item.owner === owner && item.id === id);
      if (!intent) return;
      tasks.push({
        record: {
          id,
          ownerId: owner,
          tmdbId: 7,
          provider: 'qbittorrent',
          sourceProvider: 'mteam',
          sourceReleaseId: 'release',
          lookupTag: `tag-${id}`,
          status: 'downloading',
          progress: 0,
        },
        task: {
          id: intent.plan.id,
          epoch: intent.plan.epoch,
          channels: intent.plan.channels.map((channel) => ({ channel, notified: false })),
          downloaded: false,
          notified: false,
          cancelled: false,
          nextRunAt: intent.plan.nextRunAt,
          leaseId: '',
          lockedUntil: new Date(0),
        },
      }
      );
    },
    claimIntent: async () => null,
    releaseIntent: async () => undefined,
    claimTask: async (at) => {
      const claim = tasks.find((item) => {
        return !item.task.notified && !item.task.cancelled && item.task.nextRunAt <= at && item.task.lockedUntil <= at;
      });
      if (claim) {
        claim.task.leaseId = 'lease';
        claim.task.lockedUntil = new Date(at.getTime() + CHECK_INTERVAL_MS);
      }
      return claim ?? null;
    },
    renew: async (claim) => !claim.task.cancelled,
    cancel: async (claim) => {
      claim.task.cancelled = true;
    },
    downloaded: async (claim, progress, at) => {
      Object.assign(claim.record, progress);
      claim.task.downloaded = progress.progress >= 100;
      if (claim.task.downloaded) claim.task.completedAt = at;
      return true;
    },
    channelNotified: async (claim, channel, messageId) => {
      const target = claim.task.channels.find((item) => item.channel === channel)!;
      target.notified = true;
      target.messageId = messageId;
      return !claim.task.cancelled;
    },
    finish: async (claim, at) => {
      claim.task.notified = claim.task.downloaded && claim.task.channels.every((item) => item.notified);
      claim.task.nextRunAt = new Date(at.getTime() + CHECK_INTERVAL_MS);
      claim.task.lockedUntil = new Date(0);
    },
  };
  const channels: NotificationChannel[] = ['whatsapp', 'test_channel'].map((id) => {
    return {
      id,
      name: id,
      isConfigured: async (owner) => owner !== 'unlinked',
      send: async (owner, payload) => {
        if (id === 'test_channel' && failSecond) throw new Error('temporarily unavailable');
        assert.equal(payload.title, 'Movie');
        assert.equal(payload.poster?.toString(), 'poster');
        payloads.push(payload);
        sent.push(`${owner}:${id}`);
        return { messageId: `msg-${sent.length}` };
      },
    };
  });
  const auth = {
    requireOwnerId: async (token: string | undefined) => {
      if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Login required');
      return token;
    },
  };
  const service = new NotificationService(auth, store, channels, now);
  let percent = 50;
  const progress = (): MovieDownloadProgress => {
    return {
      torrentHash: 'hash',
      name: 'resource',
      status: percent === 100 ? 'seeding' : 'downloading',
      progress: percent,
      downloadedBytes: percent,
      totalBytes: 100,
      downloadSpeed: 1,
      etaSeconds: 1,
      lastSyncedAt: now(),
    };
  };
  const worker = () => {
    return new NotificationWorker(
      service,
      {
        inspect: async (record) => {
          checked.push(record.ownerId);
          return progress();
        },
      },
      {
        readMovies: async (_ids, locale) => {
          readLocales.push(locale);
          return [{ tmdbId: 7, title: 'Movie', genreIds: [], posterPath: '/poster.jpg' }];
        },
      },
      'zh-CN',
      'http://localhost:5173',
      () => {
        return undefined;
      },
      now,
      async () => {
        return Buffer.from('poster');
      },
      false,
      localeOptions
    );
  };
  const enable = (owner: string, extra: string[] = []) => {
    return service.save(owner, { enabled: true, defaultChannel: 'whatsapp', additionalChannels: extra });
  };
  const create = async (owner: string, id: string) => {
    await service.reserve(owner, id);
    await service.submitted(owner, id);
  };
  return {
    service,
    store,
    tasks,
    plans,
    preferences,
    sent,
    checked,
    payloads,
    readLocales,
    enable,
    create,
    worker,
    advance: () => {
      time += CHECK_INTERVAL_MS;
    },
    complete: () => {
      percent = 100;
    },
    recoverChannel: () => {
      failSecond = false;
    },
  };
}

test('disabled users create no scan intent; enabled users persist targets once and start checking after two minutes', async () => {
  const f = fixture();
  await f.create('off', 'download-off');
  assert.equal(f.tasks.length, 0);
  assert.equal(f.plans.length, 0);
  await f.enable('alice', ['whatsapp']);
  await f.create('alice', 'download-a');
  assert.deepEqual(f.plans[0]?.plan.channels, ['whatsapp']);
  const worker = f.worker();
  await worker.tick();
  assert.equal(f.checked.length, 0);
  f.advance();
  await worker.tick();
  assert.deepEqual(f.checked, ['alice']);
  assert.equal(f.tasks[0]?.task.downloaded, false);
  assert.equal(f.sent.length, 0);
  await worker.tick();
  assert.equal(f.checked.length, 1);
  f.advance();
  f.complete();
  await worker.tick();
  assert.equal(f.tasks[0]?.task.downloaded, true);
  assert.equal(f.tasks[0]?.task.notified, true);
  assert.deepEqual(f.sent, ['alice:whatsapp']);
  f.advance();
  await worker.tick();
  assert.equal(f.checked.length, 2);
  assert.equal(f.sent.length, 1);
});

test('partial channel failure survives a worker restart and retries only the unsent channel without rechecking downloader', async () => {
  const f = fixture();
  await f.enable('alice', ['test_channel']);
  await f.create('alice', 'a');
  f.complete();
  f.advance();
  await f.worker().tick();
  assert.deepEqual(f.sent, ['alice:whatsapp']);
  assert.equal(f.tasks[0]?.task.downloaded, true);
  assert.equal(f.tasks[0]?.task.notified, false);
  f.advance();
  f.recoverChannel();
  await f.worker().tick();
  assert.deepEqual(f.sent, ['alice:whatsapp', 'alice:test_channel']);
  assert.equal(f.checked.length, 1);
  assert.equal(f.tasks[0]?.task.notified, true);
});

test('disabling cancels only that owner, reenabling does not revive old tasks, and new downloads still notify', async () => {
  const f = fixture();
  await f.enable('alice');
  await f.enable('bob');
  await f.create('alice', 'a');
  await f.create('bob', 'b');
  await f.service.save('alice', { enabled: false, defaultChannel: 'whatsapp', additionalChannels: [] });
  await f.enable('alice');
  f.complete();
  f.advance();
  await f.worker().tick();
  assert.deepEqual(f.checked, ['bob']);
  assert.deepEqual(f.sent, ['bob:whatsapp']);
  assert.equal(f.tasks[0]?.task.cancelled, true);
  await f.create('alice', 'c');
  f.advance();
  await f.worker().tick();
  assert.deepEqual(f.sent, ['bob:whatsapp', 'alice:whatsapp']);
});

test('preference generation prevents a stale reserve racing with disable and reenable from sending', async () => {
  const f = fixture();
  await f.enable('alice');
  await f.create('alice', 'a');
  f.preferences.set('alice', { enabled: true, defaultChannel: 'whatsapp', additionalChannels: [], epoch: 1 });
  f.complete();
  f.advance();
  await f.worker().tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.checked.length, 0);
  assert.equal(f.tasks[0]?.task.cancelled, true);
});

test('preferences require authentication and reject unsupported or unlinked targets before saving', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.get(undefined), { code: 'UNAUTHORIZED' });
  await assert.rejects(
    () => {
      return f.service.save('alice', { enabled: true, defaultChannel: 'telegram', additionalChannels: [] });
    },
    { code: 'VALIDATION_ERROR' }
  );
  await assert.rejects(() => f.enable('unlinked'), { code: 'CONFLICT' });
  assert.equal(f.preferences.size, 0);
  assert.equal((await f.service.get('alice')).enabled, false);
});

test('notification HTTP settings authenticate the owner and serialize the extensible channel catalog', async () => {
  const { buildApp } = await import('../../app.js');
  const { loadConfig } = await import('../../config/env.js');
  const config = loadConfig({
    WEB_ORIGIN: 'http://localhost:5173',
    MONGODB_URI: 'mongodb://db.example/movie_hub',
    REDIS_URL: 'redis://redis.example:6379',
    MINIO_ENDPOINT: 'minio.example',
    MINIO_ACCESS_KEY: 'access',
    MINIO_SECRET_KEY: 'secret',
    MINIO_BUCKET: 'avatars',
    SESSION_TOKEN_PEPPER: 'test-session-pepper-at-least-32-characters',
    INTEGRATION_SECRET_KEY: 'test-integration-secret-at-least-32-characters',
    TMDB_READ_ACCESS_TOKEN: 'tmdb-token',
    LOG_LEVEL: 'silent',
    ACCESS_LOG_ENABLED: 'false',
  }
  );
  const f = fixture();
  const app = await buildApp({ config, healthDependencies: [], notificationService: f.service });
  const url = '/api/v1/me/notifications';
  try {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    const headers = { cookie: 'movie_hub_session=alice' };
    const saved = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { enabled: true, defaultChannel: 'whatsapp', additionalChannels: [], ownerId: 'bob' },
    }
    );
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().channels.length, 2);
    assert.equal(saved.json().enabled, true);
    assert.equal((await f.store.preferences('bob')).enabled, false);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url,
          headers,
          payload: { enabled: true, defaultChannel: 'telegram', additionalChannels: [] },
        }
        )
      ).statusCode,
      400
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url,
          headers,
          payload: { enabled: 'bad', defaultChannel: 'whatsapp', additionalChannels: [] },
        }
        )
      ).statusCode,
      400
    );
  } finally {
    await app.close();
  }
});

test('completion uses each owner latest locale even when changed after task creation', async () => {
  const locales = new Map<string, 'en-US' | 'zh-CN'>([['alice', 'zh-CN'], ['bob', 'zh-CN']]);
  const f = fixture({ resolveLocale: async (owner) => locales.get(owner)! });
  await f.enable('alice');
  await f.enable('bob');
  await f.create('alice', 'alice-download');
  await f.create('bob', 'bob-download');
  locales.set('alice', 'en-US');
  f.complete();
  f.advance();
  await f.worker().tick();
  assert.deepEqual(f.readLocales, ['en-US', 'zh-CN']);
  assert.deepEqual(f.payloads.map((payload) => payload.locale), ['en-US', 'zh-CN']);
  assert.ok(f.payloads.every((payload) => payload.poster?.toString() === 'poster'));
});

test('locale lookup failure leaves the task retryable instead of sending in a wrong default language', async () => {
  const f = fixture({ resolveLocale: async () => {
    throw new Error('user store unavailable');
  } });
  await f.enable('alice');
  await f.create('alice', 'download');
  f.complete();
  f.advance();
  await f.worker().tick();
  assert.deepEqual(f.sent, []);
  assert.equal(f.tasks[0]!.task.notified, false);
});
