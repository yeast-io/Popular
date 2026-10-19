import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import constructorLayout from './tools/eslint/constructor-layout.mjs';
import callbackCallLayout from './tools/eslint/callback-call-layout.mjs';

const schemaBoundaryRestrictions = [
  {
    selector: "NewExpression[callee.name='Schema'], NewExpression[callee.property.name='Schema']",
    message: 'Define Mongoose schemas in the matching .schema.ts module.',
  },
  {
    selector: "CallExpression[callee.property.name='model']",
    message: 'Register database models in .schema.ts; inject models into stores.',
  },
  {
    selector: "CallExpression[callee.object.name='z'][callee.property.name!='toJSONSchema'], CallExpression[callee.object.name='Type']",
    message: 'Define runtime validation schemas in .schema.ts; consume them from business logic.',
  },
];

export default ts.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.cache/**',
      '**/.vite/**',
      '.agents/**',
      '.codex/**',
      'shared/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,vue}'],
    extends: [js.configs.recommended, ...ts.configs.recommended, ...vue.configs['flat/essential']],
    languageOptions: { globals: { ...globals.node, ...globals.browser }, parserOptions: { parser: ts.parser } },
    plugins: {
      project: { rules: { 'constructor-layout': constructorLayout, 'callback-call-layout': callbackCallLayout } },
    },
    rules: {
      'project/constructor-layout': 'error',
      'project/callback-call-layout': ['error', { maxLength: 120 }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,mjs}'],
    // Failure doubles intentionally throw before their first yield.
    rules: { 'require-yield': 'off' },
  },
  {
    files: ['apps/**/*.{ts,vue}', 'packages/**/*.ts', 'tools/**/*.ts'],
    ignores: ['**/*.schema.ts', '**/*.types.ts', '**/*.test.ts', '**/*.d.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...schemaBoundaryRestrictions,
        {
          selector: 'TSInterfaceDeclaration, TSTypeAliasDeclaration',
          message: 'Move all named interfaces and type aliases into the feature .types.ts module.',
        },
      ],
    },
  },
  {
    files: ['**/*.types.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclaration, FunctionDeclaration, ClassDeclaration, TSEnumDeclaration, ExpressionStatement',
          message: 'Keep .types.ts type-only; move executable definitions into their implementation modules.',
        },
      ],
    },
  },
  {
    files: ['apps/api/src/modules/{assistant,preferences,recommendations}/agents/**/*.ts'],
    rules: {
      'curly': ['error', 'multi-line'],
      'brace-style': ['error', '1tbs', { allowSingleLine: true }],
      'block-spacing': ['error', 'always'],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/mongodb/**', '**/*.worker.js', '**/*.workflow.js', '**/*.service.js'],
              message:
                'Agents own model calls. Put persistence, worker scheduling and business orchestration outside agents/.',
            },
          ],
        },
      ],
    },
  },
);
