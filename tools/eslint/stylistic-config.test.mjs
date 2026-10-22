import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

const filePath = 'apps/helpers/gateway/src/stylistic-probe.service.ts';

test('Stylistic owns formatting while correctness, constructor and architecture checks remain enabled', async () => {
  const config = await new ESLint().calculateConfigForFile(filePath);
  for (const name of ['indent', 'quotes', 'semi', 'brace-style', 'block-spacing', 'lines-between-class-members']) {
    assert.equal(config.rules[`@stylistic/${name}`][0], 2, name);
    assert.ok(!config.rules[name] || config.rules[name][0] === 0, name);
  }
  assert.equal(config.rules['project/constructor-layout'][0], 2);
  assert.equal(config.rules['@typescript-eslint/no-unused-vars'][0], 2);
  assert.equal(config.rules['no-restricted-syntax'][0], 2);
  assert.equal(config.rules['project/callback-call-layout'], undefined);
});

test('TypeScript formatting uses two spaces, single quotes and semicolons, with stable fixes', async () => {
  const eslint = new ESLint({ fix: true });
  const [result] = await eslint.lintText('export function greet(name:string){\nreturn "hello " +name\n}\n', { filePath });
  assert.equal(result.errorCount, 0);
  assert.equal(result.output, "export function greet(name: string) {\n  return 'hello ' + name;\n}\n");
  const [again] = await eslint.lintText(result.output, { filePath });
  assert.equal(again.output, undefined);
  assert.equal(again.errorCount, 0);
});

test('Stylistic also formats Vue TypeScript scripts without changing template text', async () => {
  const eslint = new ESLint({ fix: true });
  const template = '<template><span>{{ greeting() }}</span></template>\n';
  const [result] = await eslint.lintText('<script setup lang="ts">\nfunction greeting(){\nreturn "hello"\n}\n</script>\n' + template,
    { filePath: 'apps/web/src/features/settings/StylisticProbe.vue' });
  assert.equal(result.errorCount, 0);
  assert.ok(result.output.includes("function greeting() {\n  return 'hello';\n}"));
  assert.ok(result.output.endsWith(template));
  assert.equal((await eslint.lintText(result.output, { filePath: 'apps/web/src/features/settings/StylisticProbe.vue' }))[0].output, undefined);
});
