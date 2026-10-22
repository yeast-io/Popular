import assert from 'node:assert/strict';
import test from 'node:test';
import { compactField, compareReleases, releaseGroup, releaseResolution } from './resource-query.presentation.js';
import type { ResourceRelease } from './resource-query.types.js';

const release = (title: string): ResourceRelease => ({ provider: 'mteam', id: '1', title });

test('release groups preserve compound tags and recognize @ and terminal scene tags', () => {
  const samples = [
    ['The Martian 2015 Extended BluRay 1080p x265.10bit 2Audio MNHD-FRDS', 'MNHD-FRDS'],
    ['The Martian 2015 BluRay 2160p x265 10bit HDR 4Audio mUHD@FRDS', 'FRDS'],
    ['The Martian 2015 Extended Edition 2160p BluRay x265 10bit Atmos TrueHD 7.1-WiKi', 'WiKi'],
    ['The Martian 2015 EXTENDED UHD BluRay REMUX 2160p HEVC Atmos TrueHD7.1 2Audio-CHD.mkv', 'CHD'],
    ['The Martian 2015 2160p UHD Blu-ray HDR HEVC Atmos TrueHD 7.1-yusub@HDsky', 'HDsky'],
  ];
  for (const [title, group] of samples) assert.equal(releaseGroup(release(title!)), group);
  for (const title of ['Me@Home', 'Spider-Man', 'Movie 1080p WEB-DL', 'Film 1080p-HDR', 'Film 1080p', 'Movie'])
    assert.equal(releaseGroup(release(title)), undefined);
  assert.equal(releaseGroup({ ...release('Movie 1080p-GUESS'), releaseGroup: 'official-group' }), 'official-group');
});

test('resolution uses structured metadata before title and normalizes 2160p/UHD to 4K', () => {
  assert.equal(releaseResolution(release('Film 2160p')), '4K');
  assert.equal(releaseResolution(release('Film UHD')), '4K');
  assert.equal(releaseResolution(release('Film 1080p')), '1080p');
  assert.equal(releaseResolution({ ...release('Film 4K'), resolution: '1080p' }), '1080p');
  assert.equal(releaseResolution(release('Film')), undefined);
});

test('sorting is descending by seeders, stable by source/id, and unknown follows zero', () => {
  const entries = [
    { ...release('Unknown'), id: 'u' },
    { ...release('Zero'), id: 'z', seeders: 0 },
    { ...release('High'), id: 'b', seeders: 9 },
    { ...release('High'), id: 'a', seeders: 9 },
    { ...release('Other'), provider: 'archive', id: 'a', seeders: 9 },
  ];
  assert.deepEqual(
    entries.sort(compareReleases).map(({ provider, id }) => [provider, id]),
    [
      ['archive', 'a'],
      ['mteam', 'a'],
      ['mteam', 'b'],
      ['mteam', 'z'],
      ['mteam', 'u'],
    ]
  );
});

test('compact fields preserve UTF-16 boundaries and remove injected rows/control characters', () => {
  assert.equal(compactField('x\n2. fake\trow\u0000', 100), 'x 2. fake row');
  const compact = compactField('😀'.repeat(80), 40);
  assert.ok(compact.length <= 40);
  assert.equal(compact, '😀'.repeat(19) + '…');
});
