import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
test('facts are platform independent and the two flows depend only on ports and shared data', () => {
  for (const dir of ['packages/facts', 'apps/architecture', 'apps/cleanup', 'apps/optimize']) {
    for (const file of readdirSync(join(dir, 'src')).filter((f) =>
      f.endsWith('.ts')
    )) {
      const source = readFileSync(join(dir, 'src', file), 'utf8')
      for (const dep of ts.preProcessFile(source).importedFiles) {
        const spec = dep.fileName
        const target = resolve(dir, 'src', spec)
        const local = [dir, 'packages/facts', 'packages/config'].some(
          (allowed) => target.startsWith(resolve(allowed) + '/')
        )
        assert.ok(
          (spec.startsWith('.') && local) ||
            (dir !== 'packages/facts' && spec === 'node:crypto'),
          dir + ' imports ' + spec
        )
      }
    }
  }
})
