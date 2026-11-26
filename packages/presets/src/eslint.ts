/**
 * Shared ESLint base presets provided by architecture-kit.
 * Consuming repositories extend these presets and append project-specific rules.
 */
export const commonEslintIgnores: readonly string[] = [
  '**/node_modules/**',
  '**/out/**',
  '**/dist/**',
  '**/coverage/**',
  '**/.superpowers/**',
  '.architecture-kit/**',
  '**/.build/**'
]

export function createCommonIgnoreConfig(extraIgnores: readonly string[] = []) {
  return {
    name: 'architecture-kit/common-ignores',
    ignores: [...commonEslintIgnores, ...extraIgnores]
  }
}

export interface TypeImportsPresetOptions {
  unusedImportsPlugin: unknown
  unusedVarsPlugin?: unknown
}

export function createTypeImportsPreset({
  unusedImportsPlugin,
  unusedVarsPlugin
}: TypeImportsPresetOptions) {
  return {
    name: 'architecture-kit/type-imports',
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: {
      'unused-imports': unusedImportsPlugin,
      ...(unusedVarsPlugin
        ? { 'project-ts': { rules: { 'no-unused-vars': unusedVarsPlugin } } }
        : {})
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false }
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      ...(unusedVarsPlugin
        ? {
            'project-ts/no-unused-vars': [
              'error',
              {
                args: 'after-used',
                argsIgnorePattern: '^_',
                vars: 'all',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
                ignoreRestSiblings: true
              }
            ]
          }
        : {})
    }
  }
}
