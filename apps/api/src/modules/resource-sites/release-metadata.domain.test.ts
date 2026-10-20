import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseTitleMetadata } from './release-metadata.domain.js';

test('recognizes the screenshot metadata with video before audio and keeps the complete group', () => {
  assert.deepEqual(releaseTitleMetadata(
    'Spider-Man Brand New Day 2026 IMAX 2160p CORE WEB-DL HDR H265 DDP5.1 Atmos-BiVerse@ADWeb'
  ), {
    resolution: '2160p', medium: 'WEB-DL', videoCodec: 'H.265', audioCodec: 'E-AC-3 5.1 Atmos', releaseGroup: 'BiVerse@ADWeb',
  }
  );
});

test('recognizes audio before video, dot-separated titles and case-insensitive markers', () => {
  for (const title of [
    'Zootopia 2016 1080p BluRay DTS-HD MA 7.1 2Audio x264-EPiC',
    'Zootopia.2016.1080p.bluray.dts-hd.ma.7.1.2Audio.x264-EPiC',
  ]) {
    assert.deepEqual(releaseTitleMetadata(title), {
      resolution: '1080p', medium: 'BluRay', videoCodec: 'H.264', audioCodec: 'DTS-HD MA 7.1', releaseGroup: 'EPiC',
    }
    );
  }
  assert.deepEqual(releaseTitleMetadata('Game of Thrones S06E07 Hybrid 720p HDTV x264-DON'), {
    resolution: '720p', medium: 'HDTV', videoCodec: 'H.264', releaseGroup: 'DON',
  }
  );
});

test('avoids mistaking title hyphens and technical suffixes for groups', () => {
  assert.deepEqual(releaseTitleMetadata('Spider-Man 2026'), {});
  for (const title of ['Movie 1080p WEB-DL', 'Movie 1080p DTS-HD', 'Movie 1080p E-AC-3', 'Movie 1080p H-265', 'Movie 1080p DTS-X', 'Movie 1080p AC-3', 'Movie 1080p VC-1', 'Movie 1080p AAC-5.1']) {
    assert.equal(releaseTitleMetadata(title).releaseGroup, undefined, title);
  }
  assert.equal(releaseTitleMetadata('Movie H265').videoCodec, 'H.265');
  assert.equal(releaseTitleMetadata('Movie 2160p BluRay Remux HEVC TrueHD 7.1 Atmos-GROUP').medium, 'Remux');
});
