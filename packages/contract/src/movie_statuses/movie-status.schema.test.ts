import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { TypeSystem } from '@sinclair/typebox/system';
import { MovieReleaseListResponseSchema, MyMoviesResponseSchema } from './movie-status.schema.js';

TypeSystem.Format('date-time', (value) => !Number.isNaN(Date.parse(value)));

test('My Movies can expose a failed refresh without discarding the last successful availability', () => {
  assert.equal(Value.Check(MyMoviesResponseSchema, {
    items: [{
      tmdbId: 603,
      title: 'The Matrix',
      userStatus: 'interested',
      resourceCheck: {
        provider: 'mteam',
        checking: false,
        availability: 'available',
        lastAttemptStatus: 'error',
        lastErrorCode: 'MTEAM_RATE_LIMITED',
      },
    }],
    pagination: { page: 1, pageSize: 20, total: 1, hasMore: false },
    locale: 'zh-CN',
  }), true);
});

test('live M-Team releases contain display data without exposing credentials', () => {
  assert.equal(Value.Check(MovieReleaseListResponseSchema, {
    provider: 'mteam', availability: 'available', queriedAt: '2026-10-13T00:00:00.000Z', cached: false,
    releases: [{
      id: '991', title: 'The.Matrix.1999.2160p', detailsUrl: 'https://kp.m-team.cc/detail/991', sizeBytes: 1024, seeders: 8, leechers: 2,
      publishedAt: '2026-10-13 08:30:00', discount: 'FREE', resolution: '4K', medium: 'Remux',
      videoCodec: 'H.265', audioCodec: 'DTS-HD MA', tags: ['中字'],
    }],
  }), true);
  assert.equal(Value.Check(MovieReleaseListResponseSchema, {
    provider: 'mteam', availability: 'available', queriedAt: '2026-10-13T00:00:00.000Z', cached: false,
    releases: [{ id: '991', title: 'Release', seeders: 1, tags: [], apiKey: 'secret' }],
  }), false);
});
