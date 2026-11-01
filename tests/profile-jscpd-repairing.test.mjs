import test from 'node:test'
import assert from 'node:assert/strict'
import { newDuplicateRecords } from '../profiles/action-driver/audit-redundant/cleanup-pipeline.mjs'

test('re-pairing requires prior evidence for both exact occurrences in unchanged files', () => {
  const endpoint = name => ({ name, start: 3, end: 6, startLoc: { position: 10 }, endLoc: { position: 32 } })
  const record = (a, b, fragment = 'same fragment') =>
    JSON.stringify({ format: 'typescript', fragment, firstFile: endpoint(a), secondFile: endpoint(b) })
  const hash = 'a'.repeat(64)
  const before = Object.fromEntries(['a.ts', 'b.ts', 'c.ts'].map(name => ['packages/' + name, hash]))
  const after = { ...before, 'packages/d.ts': hash }
  const baseline = [record('a.ts', 'b.ts'), record('a.ts', 'c.ts')]
  const replay = record('b.ts', 'c.ts')
  const copy = record('b.ts', 'd.ts')
  const different = record('b.ts', 'c.ts', 'different')
  const added = (now, inputs = after) => newDuplicateRecords(baseline, now, before, inputs)
  assert.deepEqual(added([baseline[0], replay, copy, different]), [copy, different])
  for (const inputs of [{ ...after, 'packages/b.ts': 'b'.repeat(64) }, { ...after, 'apps/b.ts': hash }, {}])
    assert.deepEqual(added([replay], inputs), [replay])
  const incomplete = [record('unknown.ts', 'b.ts'), record('a.ts', 'c.ts')]
  assert.deepEqual(newDuplicateRecords(incomplete, [replay], before, after), [replay])
  const contained = JSON.parse(replay)
  contained.fragment = 'fragment'
  contained.firstFile.startLoc.position++
  contained.secondFile.startLoc.position++
  assert.deepEqual(added([JSON.stringify(contained)]), [])
  contained.secondFile.endLoc.position++
  assert.deepEqual(added([JSON.stringify(contained)]), [JSON.stringify(contained)])
  const shifted = JSON.parse(replay)
  shifted.firstFile.startLoc.position++
  assert.deepEqual(added([JSON.stringify(shifted), 'invalid']), [JSON.stringify(shifted), 'invalid'])
})

test('line movement requires unique unchanged source blocks on both sides of the same pair', () => {
  const before = { 'a.ts': '1'.repeat(64), 'b.ts': '2'.repeat(64) }
  const after = { ...before, 'a.ts': '3'.repeat(64), 'b.ts': '4'.repeat(64) }
  const record = (start, second = 'b.ts') => JSON.stringify({
    format: 'typescript', fragment: 'duplicate fragment',
    firstFile: end('a.ts', start), secondFile: end(second, start)
  })
  function end(name, start) {
    return { name, start, end: start + 1, startLoc: { column: 1, position: start * 10 }, endLoc: { column: 8, position: start * 10 + 8 } }
  }
  const texts = new Map([[before['a.ts'], 'a\nduplicate fragment\nfooterA\nz'], [before['b.ts'], 'b\nduplicate fragment\nfooterB\nz'],
    [after['a.ts'], 'added\na\nduplicate fragment\nfooterA\nz'], [after['b.ts'], 'added\nb\nduplicate fragment\nfooterB\nz']])
  const moved = record(3)
  const compare = (r = moved, inputs = after) => newDuplicateRecords([record(2)], [r], before, inputs, (_, digest) => texts.get(digest))
  assert.deepEqual(compare(), [])
  const relocated = record(3, 'new.ts')
  assert.deepEqual(compare(relocated, { ...after, 'new.ts': after['b.ts'] }), [relocated])
  for (const different of ['added\nb\nduplicate fragment\nchanged\nz','added\nb\nduplicate fragment\nfooterB\nz\nduplicate fragment\nfooterB', undefined]) {
    texts.set(after['b.ts'], different)
    assert.deepEqual(compare(), [moved])
  }
})

test('baseline text can come from Git only when its digest matches the recorded inputs', async t => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { hash } = await import('../profiles/action-driver/local-quality/native.mjs')
  const { snapshotSourceReader } = await import('../profiles/action-driver/audit-redundant/clone-source-evidence.mjs')
  const root = mkdtempSync(join(tmpdir(), 'clone-evidence-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  const file = join(root, 'module.ts')
  writeFileSync(file, 'before\n')
  git('add', 'module.ts')
  git('-c','user.name=test','-c','user.email=t@example.invalid','-c','core.hooksPath=/dev/null','commit','--no-gpg-sign','-qm','baseline')
  writeFileSync(file, 'after\n')
  const read = snapshotSourceReader(root, git('rev-parse', 'HEAD').trim())
  assert.equal(read('module.ts', hash('before\n')), 'before\n')
  assert.equal(read('module.ts', hash('after\n')), 'after\n')
  assert.equal(read('module.ts', hash('unavailable dirty baseline')), undefined)
  assert.equal(read('../module.ts', hash('before\n')), undefined)
  assert.equal(read('absent.ts', hash('before\n')), undefined)
})
