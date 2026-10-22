import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerPreferenceRoutes } from './preference.routes.js';
import type { PreferenceService } from './preference.service.js';
import type { AppConfig } from '../../config/env.schema.js';
import { AppError } from '../../infrastructure/http/app-error.js';

test('preference endpoints resolve owner from the session and reject client identity overrides', async () => {
  const app = Fastify();
  const owners: string[] = [];
  const service = {
    get: async (owner: string) => {
      owners.push(owner);
      return { version: 1 };
    },
    generate: async (owner: string) => {
      owners.push(owner);
      return { task: { status: 'pending' } };
    },
    edit: async (owner: string) => {
      owners.push(owner);
      return { version: 2 };
    },
  } as unknown as PreferenceService;
  const auth = {
    requireOwnerId: async (token: string | undefined) => {
      if (token !== 'alice-session') throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      return 'alice';
    },
  };
  registerPreferenceRoutes(app, service, auth, { SESSION_COOKIE_NAME: 'session' } as AppConfig);
  assert.equal((await app.inject({ method: 'GET', url: '/me/preferences' })).statusCode, 401);
  const headers = { cookie: 'session=alice-session' };
  assert.equal((await app.inject({ method: 'GET', url: '/me/preferences', headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/me/preferences/generate', headers })).statusCode, 202);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: '/me/preferences',
        headers,
        payload: { expectedVersion: 1, ownerId: 'bob', clear: true },
      }
      )
    ).statusCode,
    400
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: '/me/preferences',
        headers,
        payload: { expectedVersion: 1, content: 'missing target' },
      }
      )
    ).statusCode,
    400
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: '/me/preferences',
        headers,
        payload: { expectedVersion: 1, autoMaintain: false },
      }
      )
    ).statusCode,
    200
  );
  assert.deepEqual(owners, ['alice', 'alice', 'alice']);
  await app.close();
});
