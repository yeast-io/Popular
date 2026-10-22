import { ESLint, RuleTester } from 'eslint';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript-eslint';
import rule from './constructor-layout.mjs';

function fixture(length, body = '}') {
  const prefix = "  constructor(private readonly first: First, private readonly label = '";
  const suffix = "') {";
  const label = 'x'.repeat(length - prefix.length - suffix.length);
  const signature = prefix + label + suffix;
  assert.equal(signature.length, length);
  return {
    code: `class Service {\n${signature}${body}\n}`,
    output: `class Service {\n  constructor(\n    private readonly first: First,\n    private readonly label = '${label}'\n  ) {${body}\n}`,
  };
}
const tester = new RuleTester({ languageOptions: { parser: ts.parser, ecmaVersion: 'latest', sourceType: 'module' } });
tester.run('constructor-layout', rule, {
  valid: [
    fixture(120).code,
    fixture(121).output,
    'class Service {\n  constructor(\n    private readonly value = `first\nsecond`\n  ) {}\n}',
    'class Service {\n  constructor(\n    private readonly values = [\n      1,\n      2\n    ]\n  ) {}\n}',
    "class Service {\n  constructor(private readonly marker = ',') {}\n}",
    fixture(120, ' this.start(); }').code,
    'class Service {\n  constructor(private readonly store: Store) {}\n}',
    'class Service {\n  constructor() { this.start(); }\n}',
    'class Service {\n  constructor() {\n    this.start();\n  }\n}',
    'class Service {\n  constructor(\n    // Keep this dependency documented.\n    private readonly store: Store\n  ) {\n    this.start();\n  }\n}',
    'class Service { run(a, b) { return a + b; } }',
    'declare class Service { constructor(value: string); }',
    { code: fixture(121).code, options: [{ maxLength: 121 }] },
  ],
  invalid: [
    {
      code: 'class Service {\n  constructor(\n    private readonly downloads: Model<MovieDownloadDocument>\n  ) {}\n}',
      output: 'class Service {\n  constructor(private readonly downloads: Model<MovieDownloadDocument>) {}\n}',
      errors: [{ messageId: 'singleLine' }],
    },
    ...[90, 120].map((length) => ({
      code: fixture(length).output,
      output: fixture(length).code,
      errors: [{ messageId: 'singleLine' }],
    })),
    ...['}', ' this.start(); }', '\n    this.start();\n  }'].map((body) => ({
      ...fixture(121, body),
      errors: [{ messageId: 'parameter' }, { messageId: 'parameter' }, { messageId: 'closingParen' }],
    })),
    {
      ...fixture(90), options: [{ maxLength: 80 }],
      errors: [{ messageId: 'parameter' }, { messageId: 'parameter' }, { messageId: 'closingParen' }],
    },
    {
      code: 'class Service {\n  constructor(\n    private readonly store: Store, // keep\n  ) {}\n}',
      output: 'class Service {\n  constructor(\n    private readonly store: Store // keep\n  ) {}\n}',
      errors: [{ messageId: 'trailingComma' }],
    },
    {
      code: 'class Service {\n  constructor(private readonly store: Store,) {\n  }\n}',
      output: 'class Service {\n  constructor(private readonly store: Store) {}\n}',
      errors: [{ messageId: 'trailingComma' }, { messageId: 'emptyBody' }],
    },
  ],
});

test('project configuration expands long Vue constructors and fixes converge with Stylistic', async () => {
  const eslint = new ESLint({ fix: true });
  const label = 'x'.repeat(120);
  const code = `<script setup lang="ts">\nclass Probe {\n  constructor(public readonly value: string = '${label}') {}\n}\nconst probe = new Probe();\n</script>\n<template><span>{{ probe.value }}</span></template>`;
  const filePath = 'apps/web/src/features/settings/LintProbe.vue';
  const [result] = await eslint.lintText(code, { filePath });
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 0);
  assert.match(result.output, /constructor\(\n {4}public readonly value: string = 'x+'\n {2}\) \{\}/);
  const [again] = await eslint.lintText(result.output, { filePath });
  assert.equal(again.output, undefined);
  assert.equal(again.errorCount, 0);
});

test('long signatures preserve parameter comments and literal contents during automatic fixes', async () => {
  const eslint = new ESLint({ fix: (message) => message.ruleId === 'project/constructor-layout' });
  const literal = "'" + 'x'.repeat(100) + "'";
  const source = `export class Service {\n  constructor(/* dependency */ private readonly create = (a, b) => [a, b], private readonly label = ${literal}) {}\n}`;
  const [result] = await eslint.lintText(source, { filePath: 'apps/api/src/example.service.ts' });
  assert.ok(result.output.includes('constructor(/* dependency */\n    private readonly create = (a, b) => [a, b],\n'));
  assert.ok(result.output.includes(`private readonly label = ${literal}\n  ) {}`));
  const [again] = await eslint.lintText(result.output, { filePath: 'apps/api/src/example.service.ts' });
  assert.equal(again.output, undefined);
});

test('project configuration accepts both inline and multiline bodies after wrapping long signatures', async () => {
  const eslint = new ESLint({ fix: true });
  const filePath = 'apps/api/src/example.service.ts';
  for (const body of [' this.start(); }', '\n    this.start();\n  }']) {
    const source = fixture(121, body).code.replace('class Service', 'export class Service');
    const [result] = await eslint.lintText(source, { filePath });
    assert.equal(result.errorCount, 0);
    assert.ok(result.output.includes('constructor(\n'));
    assert.ok(result.output.includes(`) {${body}`));
    assert.equal((await eslint.lintText(result.output, { filePath }))[0].output, undefined);
  }
});

test('short constructors merge safely while preserving both body layouts and converge with Stylistic', async () => {
  const eslint = new ESLint({ fix: true });
  const filePath = 'apps/api/src/example.service.ts';
  for (const body of ['}', ' this.start(); }', '\n    this.start();\n  }']) {
    const source = fixture(120, body).output.replace('class Service', 'export class Service');
    const expected = fixture(120, body).code.replace('class Service', 'export class Service') + '\n';
    const [result] = await eslint.lintText(source, { filePath });
    assert.equal(result.errorCount, 0);
    assert.equal(result.output, expected);
    const [again] = await eslint.lintText(result.output, { filePath });
    assert.equal(again.output, undefined);
    assert.equal(again.errorCount, 0);
  }
});
