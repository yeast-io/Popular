import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseTags } from './release-tags.domain.js';

test('recognizes and deduplicates explicit tags across title, subtitle and image labels', () => {
  assert.deepEqual(releaseTags('Movie.2160p.DoVi', '4K 简繁字幕', 'Dolby Vision', 'CHS'), [
    '4K',
    'DoVi',
    'chinese-subtitles',
  ]
  );
  assert.deepEqual(releaseTags('Movie_4K_DV', '中英双字'), ['4K', 'DoVi', 'chinese-subtitles']);
  assert.deepEqual(releaseTags('Movie 1080p Dolby.Vision', '繁體中文字幕'), ['DoVi', 'chinese-subtitles']);
});

test('does not infer Chinese subtitles from Chinese names or Mandarin audio, nor DoVi from HDR', () => {
  for (const evidence of ['电影 1080p HDR10 国语 双音轨', 'Movie 4320p UHD HDR', 'DVD DVI 4Kids CHStream', '']) {
    assert.deepEqual(releaseTags(evidence), []);
  }
});

test('respects explicit absent or pending metadata even when repeated in other page markers', () => {
  for (const evidence of ['无中字', '不含中文字幕', '暂无字幕', '中字待补', 'No Chinese subtitles']) {
    assert.deepEqual(releaseTags(evidence, '中字'), []);
  }
  assert.deepEqual(releaseTags('Movie 1080p HDR no DoVi', 'DoVi'), []);
  assert.deepEqual(releaseTags('Movie 1080p 非4K'), []);
});
