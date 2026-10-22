import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
async function boundaryMessages(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath });
  assert.ok(!result.messages.some((message) => message.fatal), JSON.stringify(result.messages));
  return result.messages.filter((message) => message.ruleId === 'no-restricted-syntax');
}

test('store and business modules reject schema construction and model registration', async () => {
  const cases = [
    ['apps/api/src/infrastructure/mongodb/assistant/example.store.ts', 'export const schema = new Schema({});'],
    ['apps/api/src/infrastructure/mongodb/assistant/example.store.ts', 'export const schema = new mongoose.Schema({});'],
    ['apps/api/src/infrastructure/mongodb/assistant/example.store.ts', "export const model = connection.model('Example', schema);"],
    ['apps/api/src/modules/assistant/example.workflow.ts', 'export const schema = z.object({});'],
    ['apps/api/src/modules/preferences/example.routes.ts', 'export const schema = z.strictObject({});'],
    ['apps/api/src/modules/assistant/agents/example.agent.ts', 'export const schema = z.object({});'],
    ['packages/contract/src/common/example.ts', 'export const schema = Type.Object({});'],
  ];
  for (const [file, code] of cases) assert.ok((await boundaryMessages(code, file)).length > 0, file);
});

test('schema modules can construct schemas while consumers can parse and export JSON schema', async () => {
  const cases = [
    ['apps/api/src/infrastructure/mongodb/assistant/example.schema.ts', "export const schema = new Schema({}); export const model = connection.model('Example', schema);"],
    ['apps/api/src/modules/assistant/example.schema.ts', 'export const schema = z.object({});'],
    ['packages/contract/src/common/example.schema.ts', 'export const schema = Type.Object({});'],
    ['apps/api/src/modules/assistant/example.agent.ts', 'export const schema = z.toJSONSchema(ExampleSchema); export const parsed = ExampleSchema.parse({});'],
  ];
  for (const [file, code] of cases) assert.deepEqual(await boundaryMessages(code, file), [], file);
});

test('types modules reject executable definitions and accept interfaces and aliases', async () => {
  for (const code of [
    'export const timeout = 10;',
    'export function empty() { return {}; }',
    'export class ProviderError extends Error {}',
    "export enum Status { Pending = 'pending' }",
  ]) assert.ok((await boundaryMessages(code, 'apps/api/src/modules/assistant/example.types.ts')).length > 0, code);
  assert.deepEqual(await boundaryMessages(
    'export interface State { id: string } export type StateReader = () => State;',
    'apps/api/src/modules/assistant/example.types.ts'
  ), []
  );
});

test('workflow modules reject named interfaces and type aliases', async () => {
  for (const code of ['interface Turn { id: string }', 'type Action = { kind: string };']) {
    assert.ok((await boundaryMessages(code, 'apps/api/src/modules/assistant/example.workflow.ts')).length > 0);
    assert.deepEqual(await boundaryMessages(code, 'apps/api/src/modules/assistant/example.types.ts'), []);
  }
});

test('named type boundaries cover queue, worker, service, infrastructure, frontend and Vue implementations', async () => {
  for (const file of [
    'apps/api/src/modules/assistant/example.queue.ts',
    'apps/api/src/modules/assistant/example.worker.ts',
    'apps/api/src/modules/assistant/example.service.ts',
    'apps/api/src/infrastructure/redis/example.ts',
    'apps/web/src/features/example/example.ts',
    'packages/contract/src/common/example.ts',
  ]) {
    for (const code of ['export interface State { id: string }', 'type State = { id: string };']) {
      assert.ok((await boundaryMessages(code, file)).length > 0, file);
    }
  }
  assert.ok((await boundaryMessages(
    '<script setup lang="ts">interface State { id: string }</script><template><div /></template>',
    'apps/web/src/features/example/Example.vue'
  )).length > 0
  );
});
