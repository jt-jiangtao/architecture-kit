import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import unusedImports from 'eslint-plugin-unused-imports'

const require = createRequire(fileURLToPath(import.meta.resolve('eslint')))
const js = require('@eslint/js')

const nodeGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Buffer: 'readonly',
  EventSource: 'readonly',
  Response: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  crypto: 'readonly',
  fetch: 'readonly',
  process: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly'
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-server/**',
      'artifacts/**',
      'workbench/**',
      'playground/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['bin/**/*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals
    },
    plugins: {
      'unused-imports': unusedImports
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_'
        }
      ]
    }
  }
]
