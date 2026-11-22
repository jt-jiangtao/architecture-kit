import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSymbolDeadCode } from '@architecture-kit/analyzers'

for (const directory of ['packages/demo', 'packages/ui/workbench/core'])
 test('counts an independent mobile import against its workspace export only: ' + directory, t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mobile-export-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name, body) => {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
  write(`${directory}/package.json`, JSON.stringify({ name: '@test/demo', exports: { './native': './src/native.ts' } }))
  write(`${directory}/src/native.ts`, 'export const NativeGlyph = 1; export const LocalOnly = 2')
  write('apps/mobile/package.json', JSON.stringify({ name: 'mobile', exports: './src/index.ts' }))
  write('apps/mobile/src/index.ts', "import { NativeGlyph as Glyph } from '@test/demo/native'; export const LocalOnly = Glyph")
  const out = path.join(root, 'artifacts/probe')
  fs.mkdirSync(out, { recursive: true })
  runSymbolDeadCode(root, out)
  const report = JSON.parse(fs.readFileSync(path.join(out, 'symbol-dead-code.json')))
  assert.deepEqual(report.deadValueExports.map(row => row.name), ['LocalOnly'])
  assert.deepEqual(report.thinUsage.find(row => row.name === 'NativeGlyph').samples, ['apps/mobile/src/index.ts'])
  assert.equal(report.entryFileCount, 1)
})
