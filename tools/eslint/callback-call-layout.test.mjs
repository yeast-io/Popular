import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { ESLint, Linter } from 'eslint';
import ts from 'typescript-eslint';
import rule from './callback-call-layout.mjs';

function fix(code, maxLength = 100) {
  return new Linter().verifyAndFix(code, [
    {
      languageOptions: { parser: ts.parser, ecmaVersion: 'latest', sourceType: 'module' },
      plugins: { project: { rules: { layout: rule } } },
      rules: { 'project/layout': ['error', { maxLength }], 'no-unexpected-multiline': 'error' },
    },
  ]);
}
function formatted(code, expected, maxLength = 100) {
  const result = fix(code, maxLength);
  assert.deepEqual(result.messages, []);
  assert.equal(result.output, expected);
  const repeated = fix(result.output, maxLength);
  assert.equal(repeated.fixed, false, 'auto-fix must be stable');
  assert.deepEqual(repeated.messages, []);
  return result.output;
}

test('100 characters including indentation is allowed; 101 expands with an explicit return', () => {
  const prefix = '  const callback = () => action(';
  const code = `${prefix}'${'x'.repeat(100 - prefix.length - 4)}');`;
  assert.equal(code.length, 100);
  formatted(code, code);
  const longer = code.replace("');", "x');");
  assert.equal(longer.length, 101);
  formatted(longer, longer.replace('() => action(', '() => {\n    return action(').replace(/;$/, ';\n  };'));
});

test('the requested layout keeps short nested arrows and groups simple arguments', () => {
  const code =
    "await aiStep('assistant.preference.enqueue', () => this.options.preferences!.chatEvidence(input.ownerId, eventId, input.text, history.map(message => `${message.role}: ${message.content}`)));";
  formatted(
    code,
    `await aiStep('assistant.preference.enqueue', () => {
  return this.options.preferences!.chatEvidence(
    input.ownerId, eventId, input.text,
    history.map(message => \`\${message.role}: \${message.content}\`)
  );
});`,
  );
});

test('short arrows, including literals, retain their existing form', () => {
  for (const code of [
    "await aiStep('dequeue', () => 'action.dequeue');",
    'const square = value => value * value;',
    'const callback = () => ({ value: 1 });',
  ]) {
    formatted(code, code);
  }
});

test('async, object and sequence expression return values survive formatting', async () => {
  for (const expression of [
    "({ description: 'a sufficiently long description to exceed this test limit' })",
    "(record.push('first'), record.push('second'), 42)",
    "await Promise.resolve('a sufficiently long description to exceed this test limit')",
  ]) {
    const code = `const record = []; const callback = async () => ${expression}; callback();`;
    const result = fix(code, 70);
    assert.deepEqual(result.messages, []);
    assert.match(result.output, /async \(\) => \{\n {2}return /);
    assert.deepEqual(
      JSON.stringify(await vm.runInNewContext(result.output)),
      JSON.stringify(await vm.runInNewContext(code)),
    );
    assert.equal(fix(result.output, 70).fixed, false);
  }
});

test('existing block callbacks do not acquire a return value', () => {
  const code =
    "const callback = () => { record.push('first side effect'); record.push('second side effect'); }; callback();";
  const result = fix(code);
  assert.deepEqual(result.messages, []);
  assert.doesNotMatch(result.output, /return/);
  assert.equal(vm.runInNewContext(`const record = []; ${result.output}`), undefined);
});

test('comments around implicit returns cannot introduce ASI or disappear', () => {
  const code = `const callback = () => // keep the explanation
  action('a sufficiently long argument to require a multiline callback for this test');`;
  const result = fix(code, 70);
  assert.deepEqual(result.messages, []);
  assert.match(result.output, /\/\/ keep the explanation\n {2}return action/);
  assert.equal(
    vm.runInNewContext(`${result.output}\ncallback();`, { action: (value) => value }),
    'a sufficiently long argument to require a multiline callback for this test',
  );
  assert.equal(fix(result.output, 70).fixed, false);
});

test('call argument parentheses, optional calls, type arguments and comments are preserved', () => {
  for (const call of [
    "action((first), ((second)), 'a sufficiently long third argument to force wrapping')",
    "action?.((first), ((second)), 'a sufficiently long third argument to force wrapping')",
    "action<string>((first), ((second)), 'a sufficiently long third argument to force wrapping')",
    "action(first, /* keep argument */ second, 'a sufficiently long third argument to force wrapping', /* keep trailing */)",
  ]) {
    const result = fix(`const callback = () => ${call};`, 70);
    assert.deepEqual(result.messages, []);
    assert.equal(fix(result.output, 70).fixed, false);
    if (call.includes('(first)')) assert.ok(result.output.includes('(first)'));
    if (call.includes('((second))')) assert.ok(result.output.includes('((second))'));
    if (call.includes('/*')) {
      assert.ok(result.output.includes('/* keep argument */'));
      assert.ok(result.output.includes('/* keep trailing */'));
    }
  }
});

test('multiline template contents are preserved byte for byte', () => {
  const literal =
    '`first line\n    second line with original spaces and enough text to exceed the configured limit\nlast line`';
  const code = `const callback = () => ${literal};`;
  const result = fix(code, 60);
  assert.deepEqual(result.messages, []);
  assert.ok(result.output.includes(literal));
  assert.equal(vm.runInNewContext(`${result.output}\ncallback();`), vm.runInNewContext(`${code}\ncallback();`));
});

test('nested callbacks converge without altering the returned result', () => {
  const code =
    "const callback = () => [1, 2].map(value => [value, value + 1].map(next => ({ value: next, description: 'a sufficiently long description' }))); callback();";
  const result = fix(code, 80);
  assert.deepEqual(result.messages, []);
  assert.equal(fix(result.output, 80).fixed, false);
  assert.equal(JSON.stringify(vm.runInNewContext(result.output)), JSON.stringify(vm.runInNewContext(code)));
});

test('project configuration applies the rule inside Vue TypeScript scripts', async () => {
  const eslint = new ESLint({ fix: true });
  const [result] = await eslint.lintText(
    `<script setup lang="ts">
const values = ['example'];
const result = values.map(value => ({ value, description: 'A sufficiently long description to expand this arrow callback' }));
</script>
<template><span>{{ result }}</span></template>`,
    { filePath: 'apps/web/src/features/settings/LintProbe.vue' },
  );
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 0);
  assert.match(result.output, /value => \{\n {2}return \(/);
});

test('an already multiline expression gains a return without extra indentation or a detached closing parenthesis', () => {
  formatted(
    `await aiStep('assistant.preference.enqueue', () =>
  this.options.preferences!.chatEvidence(
    input.ownerId, eventId, input.text,
    history.map(message => \`\${message.role}: \${message.content}\`)
  )
);`,
    `await aiStep('assistant.preference.enqueue', () => {
  return this.options.preferences!.chatEvidence(
    input.ownerId, eventId, input.text,
    history.map(message => \`\${message.role}: \${message.content}\`)
  );
});`,
  );
});

test('multiline calls with a single short block callback stay stable', () => {
  const code = `afterEach(
  () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); }
);`;
  const result = fix(code);
  assert.deepEqual(result.messages, []);
  assert.equal(fix(result.output).fixed, false);
});

test('default callbacks do not pull a constructor closing parenthesis onto their brace', () => {
  const code = `class Probe {
  constructor(
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  ) {}
}`;
  formatted(code, code);
});


test('computed iterator access stays attached to a multiline call after fixing', () => {
  const code = `const iterator = service
  .stream({
    ownerId: 'owner-1',
    threadId: 'thread-1',
  })
  [Symbol.asyncIterator]();`;
  const expected = `const iterator = service
  .stream({
    ownerId: 'owner-1',
    threadId: 'thread-1',
  })[Symbol.asyncIterator]();`;
  formatted(code, expected, 120);
});

test('computed access preserves object parentheses, property parentheses and comments', () => {
  formatted('const value = ((object))\n  [(key)];', 'const value = ((object))[(key)];');
  const code = 'const value = object /* keep */\n  [key];';
  // A comment gap is deliberately not rewritten; callers must not lose comment text.
  const result = fix(code);
  assert.ok(result.output.includes('/* keep */'));
});

test('callback call wrapping and computed access fixing converge together', () => {
  const code = `const callback = () => service.stream({ ownerId: 'owner-1', threadId: 'thread-1', clientRequestId: 'request-stream' })
  [Symbol.asyncIterator]();`;
  const result = fix(code, 100);
  assert.deepEqual(result.messages, []);
  assert.match(result.output, /\)\[Symbol\.asyncIterator\]\(\)/);
  assert.equal(fix(result.output, 100).fixed, false);
});
