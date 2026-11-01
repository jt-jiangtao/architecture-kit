import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const project = path.resolve(import.meta.dirname, '../../..')
test('import graph reports live dependencies and fails rather than publishing incomplete results on read errors', () => {
  const parent = path.join(project, 'artifacts/test-reports/excessive-defense-20261030/batch2/tmp')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'import-graph-'))
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  try {
    for (const name of ['lib.mjs', 'output-native.mjs', '02-import-graph.mjs'])
      write(`scripts/audit-redundant/${name}`, fs.readFileSync(path.join(project, 'profiles/action-driver/audit-redundant', name)))
    write('apps/demo/src/main.ts', "import './leaf'\n")
    write('apps/demo/src/leaf.ts', 'export const live = true\n')
    write('artifacts/probe/entries.json', JSON.stringify({ packageNameToDir: {}, entries: ['apps/demo/src/main.ts'] }))
    const output = path.join(root, 'artifacts/probe/import-graph.json')
    const env = { ...process.env, AUDIT_REDUNDANT_OUT: path.dirname(output) }
    const stage = 'scripts/audit-redundant/02-import-graph.mjs'
    const healthy = spawnSync(process.execPath, [stage], { cwd: root, env, encoding: 'utf8' })
    assert.equal(healthy.status, 0, healthy.stderr)
    assert.equal(JSON.parse(fs.readFileSync(output)).fullyOrphan.includes('apps/demo/src/leaf.ts'), false)
    fs.unlinkSync(output)
    for (const code of ['EIO', 'ENOENT']) {
      write('fault.mjs', `import fs from 'node:fs'; const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if (String(file).endsWith('/apps/demo/src/main.ts')) throw Object.assign(new Error('injected ${code}'), { code: '${code}' }); return read.call(this, file, ...args) }`)
      const fault = spawnSync(process.execPath, ['--import', './fault.mjs', stage], { cwd: root, env, encoding: 'utf8' })
      assert.notEqual(fault.status, 0)
      assert.match(fault.stderr, new RegExp(code))
      assert.equal(fs.existsSync(output), false)
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
