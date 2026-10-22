import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

const ruleId = '@stylistic/lines-between-class-members';
const filePath = 'apps/helpers/gateway/src/example.service.ts';

test('class methods require a blank line, including constructor, async, static and accessors', async () => {
  const eslint = new ESLint();
  const source = `export class Example {
  constructor() {}
  async first() {}
  static second() {}
  get value() { return 1; }
}`;
  const [result] = await eslint.lintText(source, { filePath });
  assert.equal(result.messages.filter((m) => m.ruleId === ruleId).length, 3);
  const fixer = new ESLint({ fix: (message) => message.ruleId === ruleId });
  const [fixed] = await fixer.lintText(source, { filePath });
  assert.equal(fixed.output, source.replaceAll('{}\n', '{}\n\n'));
  assert.equal(fixed.messages.filter((m) => m.ruleId === ruleId).length, 0);
});

test('method spacing does not require blank lines between fields or inside methods', async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(`export class Example {
  first = 1;
  second = 2;

  method() {
    this.first++;
    this.second++;
  }

  next() {}
}`, { filePath }
  );
  assert.equal(result.messages.filter((m) => m.ruleId === ruleId).length, 0);
});
