import { ESLint, RuleTester } from 'eslint';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript-eslint';
import rule from './constructor-layout.mjs';

const tester = new RuleTester({ languageOptions: { parser: ts.parser, ecmaVersion: 'latest', sourceType: 'module' } });
tester.run('constructor-layout', rule, {
  valid: [
    'class Service {\n  constructor(\n    private readonly createLlm: (ownerId: string) => Promise<Pick<LlmClient, "generate">>,\n    private readonly maxContextTokens = 32_000\n  ) {}\n}',
    'class Service {\n  constructor(\n    private readonly store: Store,\n    private readonly limit = 5\n  ) {}\n}',
    'class Service {\n  constructor() {}\n}',
    'class Service {\n  constructor(\n    // Keep this dependency documented.\n    private readonly store: Store\n  ) {\n    this.start();\n  }\n}',
    'class Service { run(a, b) { return a + b; } }',
    'declare class Service { constructor(value: string); }',
  ],
  invalid: [
    {
      code: 'class Service {\n  constructor(\n    private readonly store: Store, // keep\n  ) {}\n}',
      output: 'class Service {\n  constructor(\n    private readonly store: Store // keep\n  ) {}\n}',
      errors: [{ messageId: 'trailingComma' }],
    },
    {
      code: 'class Service {\n  constructor(\n    private readonly store: Store,\n  )\n  {\n  }\n}',
      output: 'class Service {\n  constructor(\n    private readonly store: Store\n  ) {}\n}',
      errors: [{ messageId: 'trailingComma' }, { messageId: 'openingBrace' }, { messageId: 'emptyBody' }],
    },
    {
      code: 'class Service {\n  constructor(private readonly store: Store, private readonly limit = 5) {}\n}',
      output:
        'class Service {\n  constructor(\n    private readonly store: Store,\n    private readonly limit = 5\n  ) {}\n}',
      errors: [{ messageId: 'parameter' }, { messageId: 'parameter' }, { messageId: 'closingParen' }],
    },
    {
      code: 'class Service {\n  constructor() { this.start(); }\n}',
      output: 'class Service {\n  constructor() {\n    this.start();\n  }\n}',
      errors: [{ messageId: 'body' }, { messageId: 'body' }],
    },
    {
      code: 'class Service {\n  constructor(/* keep */ private readonly get = (a, b) => [a, b]) {}\n}',
      output: 'class Service {\n  constructor(/* keep */\n    private readonly get = (a, b) => [a, b]\n  ) {}\n}',
      errors: [{ messageId: 'parameter' }, { messageId: 'closingParen' }],
    },
  ],
});

test('the project config enforces constructor layout inside Vue TypeScript scripts', async () => {
  const eslint = new ESLint({ fix: true });
  const [result] = await eslint.lintText(
    '<script setup lang="ts">\nclass Probe {\n  constructor(public readonly value: number) {}\n}\nconst probe = new Probe(1);\n</script>\n<template><span>{{ probe.value }}</span></template>',
    { filePath: 'apps/web/src/features/settings/LintProbe.vue' },
  );
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 0);
  assert.match(result.output, /constructor\(\n {4}public readonly value: number\n {2}\) \{\}/);
});
