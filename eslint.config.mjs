import js from '@eslint/js';
import ts from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import stylistic from '@stylistic/eslint-plugin';
import constructorLayout from './tools/eslint/constructor-layout.mjs';

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
      '**/src-tauri/target/**',
      '**/src-tauri/gen/**',
      '**/coverage/**',
      '**/.cache/**',
      '**/.vite/**',
      '.agents/**',
      '.codex/**',
      '.archify/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,vue}'],
    extends: [
      js.configs.recommended,
      ...ts.configs.recommended,
      ...vue.configs['flat/essential'],
      stylistic.configs.customize({ indent: 2, quotes: 'single', semi: true, braceStyle: '1tbs', jsx: false }),
    ],
    languageOptions: { globals: { ...globals.node, ...globals.browser }, parserOptions: { parser: ts.parser } },
    plugins: {
      project: { rules: { 'constructor-layout': constructorLayout } },
    },
    rules: {
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
      ],

      '@stylistic/lines-between-class-members': [
        'error',
        {
          enforce: [
            { blankLine: 'always', prev: 'field', next: 'method' },
            { blankLine: 'always', prev: 'method', next: 'method' },
          ],
        },
      ],

      '@stylistic/arrow-parens': ['error', 'always'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      // Constructor layout forbids a trailing comma after its last parameter.
      '@stylistic/comma-dangle': ['error', {
        arrays: 'always-multiline', objects: 'always-multiline', imports: 'always-multiline',
        exports: 'always-multiline', functions: 'never', generics: 'always-multiline', tuples: 'always-multiline',
      }],
      'project/constructor-layout': ['error', { maxLength: 120 }],
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
  }
);
