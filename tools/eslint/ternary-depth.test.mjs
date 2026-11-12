import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint, RuleTester } from 'eslint';
import ts from 'typescript-eslint';
import rule from './ternary-depth.mjs';

new RuleTester({ languageOptions: { parser: ts.parser } }).run('ternary-depth', rule, {
  valid: [
    'const result = a ? b : c;',
    'const result = a ? b : c ? d : e;',
    'const result = a ? (b ? c : d) : (e ? f : g);',
    'const result = (a ? b : c) ? d : e;',
    'const result = a ? { b: c ? d : e } : f;',
    'const result = a ? () => b ? c : d ? e : f : g;',
    'type Result<T> = T extends string ? T extends "a" ? "a" : "b" : number;',
  ],
  invalid: [
    { code: 'const result = a ? b : c ? d : e ? f : g;', errors: [{ messageId: 'tooDeep' }] },
    { code: 'const result = a ? b ? c ? d : e : f : g;', errors: [{ messageId: 'tooDeep' }] },
    { code: 'const result = ((a ? b : c) ? d : e) ? f : g;', errors: [{ messageId: 'tooDeep' }] },
    { code: 'const result = a ? { b: c ? { d: e ? f : g } : h } : i;', errors: [{ messageId: 'tooDeep' }] },
    { code: 'const result = a ? b : c ? d : e ? f : g ? h : i;', errors: [{ messageId: 'tooDeep' }, { messageId: 'tooDeep' }] },
  ],
});

test('project configuration enforces two levels in Vue scripts, interpolations and bindings', async () => {
  const eslint = new ESLint();
  const code = `<script setup lang="ts">
const a = true, b = true, c = true;
const value = a ? 1 : b ? 2 : c ? 3 : 4;
</script>
<template><span :title="a ? 'a' : b ? 'b' : c ? 'c' : 'd'">{{ a ? 1 : b ? 2 : c ? 3 : value }}</span></template>`;
  const [result] = await eslint.lintText(code, { filePath: 'apps/web/src/features/settings/TernaryProbe.vue' });
  assert.equal(result.messages.filter((message) => message.ruleId === 'project/ternary-depth').length, 3);
});
