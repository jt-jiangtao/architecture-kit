import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runImportGraph } from '@architecture-kit/analyzers'

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
    write('apps/demo/src/main.ts', "import './leaf'\n")
    write('apps/demo/src/leaf.ts', 'export const live = true\n')
    write(
      'artifacts/probe/entries.json',
      JSON.stringify({ packageNameToDir: {}, entries: ['apps/demo/src/main.ts'] })
    )
    const outDir = path.join(root, 'artifacts/probe')
    const output = path.join(outDir, 'import-graph.json')
    runImportGraph(root, outDir)
    assert.equal(
      JSON.parse(fs.readFileSync(output, 'utf8')).fullyOrphan.includes('apps/demo/src/leaf.ts'),
      false
    )
    fs.unlinkSync(output)
    const origRead = fs.readFileSync
    for (const code of ['EIO', 'ENOENT']) {
      try {
        fs.readFileSync = function (file, ...args) {
          if (String(file).endsWith('/apps/demo/src/main.ts')) {
            throw Object.assign(new Error(`injected ${code}`), { code })
          }
          return origRead.call(this, file, ...args)
        }
        assert.throws(() => runImportGraph(root, outDir), new RegExp(code))
        assert.equal(fs.existsSync(output), false)
      } finally {
        fs.readFileSync = origRead
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
