'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'harness/data/**', 'harness/logs/**', 'export/**', 'nsf/**', 'docs/**'],
  },
  js.configs.recommended,
  {
    files: ['harness/**/*.js', 'tools/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
      strict: ['error', 'global'],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['harness/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      strict: ['error', 'function'],
      'no-var': 'off',
      'prefer-const': 'off',
    },
  },
];
