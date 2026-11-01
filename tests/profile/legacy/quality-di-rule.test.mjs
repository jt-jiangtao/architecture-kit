import { RuleTester } from 'eslint'
import rule from '../../../profiles/action-driver/local-quality/rules/no-global-fallback.mjs'
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } })
tester.run('no-global-fallback', rule, {
  valid: [
    'const text = "ports.fetch ?? fetch";',
    '// const now = ports.now ?? Date.now;\nconst now = ports.now;',
    'function choose(fetch, port) { return port ?? fetch; }',
    'function choose(Date, port) { return port ?? Date.now; }',
    'const fetcher = ports.fetch; fetcher(url);'
  ],
  invalid: [
    { code: 'const f = ports.fetch ?? fetch;', errors: [{ messageId: 'fallback' }] },
    { code: 'const f = ports.fetch ?? globalThis.fetch;', errors: [{ messageId: 'fallback' }] },
    { code: 'const now = ports.now || Date.now;', errors: [{ messageId: 'fallback' }] },
    { code: 'function run(fetcher = fetch) {}', errors: [{ messageId: 'fallback' }] },
    { code: 'const { now = Date.now } = ports;', errors: [{ messageId: 'fallback' }] }
  ]
})
