import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

test('dead-test audit resolves source imports and ignores embedded fixture programs', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dead-test-imports-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'tests'))
  fs.mkdirSync(path.join(root, 'tests/pkg'))
  fs.writeFileSync(path.join(root, 'tests/pkg/package.json'), JSON.stringify({ types: 'api.d.ts' }))
  fs.writeFileSync(path.join(root, 'tests/pkg/api.d.ts'), 'export type Input = string')
  const out = path.join(root, 'artifacts/probe')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(root, 'tests/module.test.tsx'), [
    "import './missing-side-effect'",
    "export { foo } from './missing-export'",
    "type Declared = import('./pkg').Input",
    "type Input = import('./missing-type').Input",
    "const lazy = () => import('./missing-lazy')",
    "const cjs = require('./missing-cjs')",
    "const fixture = \"import './relative-to-fixture'\"",
    "const jsx = <span>import './jsx-text'</span>"
  ].join('\n'))
  const stage = path.resolve(import.meta.dirname, '../profiles/action-driver/audit-redundant/12-dead-tests.mjs')
  execFileSync(process.execPath, [stage], { cwd: root, env: { ...process.env, AUDIT_REDUNDANT_OUT: out } })
  const report = JSON.parse(fs.readFileSync(path.join(out, 'dead-tests.json')))
  assert.deepEqual(report.brokenImports.map(row => row.spec).sort(), [
    './missing-cjs', './missing-export', './missing-lazy', './missing-side-effect', './missing-type'
  ])
})
