import assert from 'node:assert/strict';
import test from 'node:test';
import { apiData, apiRelease } from './hdarea.parser.js';
import { hdareaReleaseSchema } from './hdarea.schema.js';

test('maps verified API fields, zero values, episode subtitles and semantic tags without exposing download URLs', () => {
  const row = hdareaReleaseSchema.parse({
    id: 123,
    name: 'Movie 2160p WEB-DL H265 DDP5.1 Atmos-GROUP',
    small_descr: '第10-16集 中英双字',
    size: 0,
    seeders: 0,
    imdb_id: 'tt0816692',
    added_ts: 1790000000,
    tags: ['Dolby Vision'],
    download_url: 'private-link',
    info_hash: 'private-hash',
  });
  const result = apiRelease(row, 'https://hdarea.example/');
  assert.equal(result.id, '123');
  assert.equal(result.sizeBytes, 0);
  assert.equal(result.seeders, 0);
  assert.equal(result.description, '第10-16集 中英双字');
  assert.equal(result.videoCodec, 'H.265');
  assert.equal(result.audioCodec, 'E-AC-3 5.1 Atmos');
  assert.equal(result.releaseGroup, 'GROUP');
  assert.deepEqual(result.tags, ['4K', 'DoVi', 'chinese-subtitles']);
  assert.equal(result.publishedAt, new Date(1790000000000).toISOString());
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('handles explicit empty and unknown fields without inventing metadata', () => {
  const row = hdareaReleaseSchema.parse({ id: 1, name: 'Movie', tags: [], added_ts: null });
  assert.deepEqual(apiRelease(row, 'https://hdarea.example/'), {
    id: '1',
    title: 'Movie',
    detailsUrl: 'https://hdarea.example/details.php?id=1',
  });
});

test('rejects HTML, malformed envelopes and HTTP-200 API errors', () => {
  for (const text of ['<html>404</html>', '{}', '{"success":false,"code":403}', '{"success":true,"code":12,"data":{}}'])
    assert.throws(() => apiData(Buffer.from(text)));
});
