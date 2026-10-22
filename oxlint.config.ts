import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['typescript', 'oxc', 'import', 'node'],
  jsPlugins: ['eslint-plugin-perfectionist'],
  categories: {
    correctness: 'error',
    suspicious: 'error'
  },
  env: {
    builtin: true,
    node: true
  },
  rules: {
    'no-console': 'error',
    'no-var': 'error',
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: '^\\.{1,2}/.*\\.js$',
            message: 'Node runs the TypeScript source directly, so import local modules with their .ts extension.'
          }
        ]
      }
    ],
    'prefer-const': 'error',
    'no-implicit-coercion': [
      'error',
      {
        boolean: true,
        number: true,
        string: true
      }
    ],
    'typescript/ban-ts-comment': [
      'error',
      {
        minimumDescriptionLength: 10
      }
    ],
    'typescript/explicit-function-return-type': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/no-non-null-assertion': 'error',
    'perfectionist/sort-imports': [
      'error',
      {
        type: 'line-length',
        order: 'asc',
        ignoreCase: true,
        newlinesBetween: 1,
        environment: 'node',
        groups: [
          'type-import',
          ['value-builtin', 'value-external'],
          'type-internal',
          'value-internal',
          ['type-parent', 'type-sibling', 'type-index'],
          ['value-parent', 'value-sibling', 'value-index'],
          'unknown'
        ]
      }
    ]
  }
});
