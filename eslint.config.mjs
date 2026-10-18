import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import constructorLayout from './tools/eslint/constructor-layout.mjs';

export default ts.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.cache/**', '**/.vite/**', '.agents/**', '.codex/**', 'shared/**'] },
  {
    files: ['**/*.{js,mjs,cjs,ts,vue}'],
    extends: [js.configs.recommended, ...ts.configs.recommended, ...vue.configs['flat/essential']],
    languageOptions: { globals: { ...globals.node, ...globals.browser }, parserOptions: { parser: ts.parser } },
    plugins: { project: { rules: { 'constructor-layout': constructorLayout } } },
    rules: {
      'project/constructor-layout': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    files: ['**/*.test.{ts,mjs}'],
    // Failure doubles intentionally throw before their first yield.
    rules: { 'require-yield': 'off' },
  },
  {
    files: ['apps/api/src/modules/{assistant,preferences,recommendations}/agents/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: ['**/infrastructure/mongodb/**', '**/*.worker.js', '**/*.workflow.js', '**/*.service.js'],
        message: 'Agents own model calls. Put persistence, worker scheduling and business orchestration outside agents/.',
      }] }],
    },
  },
);
