import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendationMessages } from './recommendation.messages.js';

test('Chinese restriction labels do not duplicate sentence punctuation from model output', () => {
  const reply = recommendationMessages('zh-CN').unverifiableRestrictions([
    ' 必须完全没有血腥。。 \n',
    '不得包含任何惊吓！ ',
  ]);
  assert.equal(
    reply,
    '目前的电影资料无法可靠核实这些硬性限制：必须完全没有血腥、不得包含任何惊吓。本次不返回未经核实的推荐。'
  );
});

test('English restriction labels have one final period and retain punctuation inside the label', () => {
  const reply = recommendationMessages('en-US').unverifiableRestrictions([' No gore... ', 'No jump-scares!']);
  assert.equal(
    reply,
    'The available movie data cannot reliably verify these strict requirements: No gore, No jump-scares. No unverified recommendations will be returned.'
  );
});
