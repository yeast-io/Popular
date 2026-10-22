import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { CreateMovieDownloadRequestSchema, DownloadProviderListResponseSchema, MovieDownloadSchema } from './movie-download.schema.js';

test('download contracts accept only supported provider choices and preserve legacy omitted choices', () => {
  assert.equal(Value.Check(CreateMovieDownloadRequestSchema, { sourceReleaseId: '991' }), true);
  for (const provider of ['qbittorrent', 'transmission']) {
    assert.equal(Value.Check(CreateMovieDownloadRequestSchema, { sourceReleaseId: '991', provider }), true);
    assert.equal(
      Value.Check(MovieDownloadSchema, {
        id: 'one',
        tmdbId: 603,
        sourceProvider: 'mteam',
        sourceReleaseId: '991',
        provider,
        status: 'downloading',
        progress: 30,
      }
      ),
      true
    );
  }
  assert.equal(Value.Check(CreateMovieDownloadRequestSchema, { sourceReleaseId: '991', provider: 'unknown' }), false);
  assert.equal(Value.Check(DownloadProviderListResponseSchema, { providers: ['qbittorrent', 'transmission'] }), true);
  assert.equal(Value.Check(DownloadProviderListResponseSchema, { providers: [], password: 'secret' }), false);
});

test('HDArea download requests accept only source identity and reject client supplied credentials or torrent URLs', () => {
  assert.equal(
    Value.Check(CreateMovieDownloadRequestSchema, { sourceProvider: 'hdarea', sourceReleaseId: '123' }),
    true
  );
  for (const extra of [{ passkey: 'must-not-be-sent' }, { torrentUrl: 'https://hdarea.example/download.php?passkey=secret' }, { sourceProvider: 'unknown' }]) {
    assert.equal(
      Value.Check(CreateMovieDownloadRequestSchema, { sourceProvider: 'hdarea', sourceReleaseId: '123', ...extra }),
      false
    );
  }
});
