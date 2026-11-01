import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateRemoval, applyRemoval } from '../../../profiles/action-driver/audit-redundant/removal.mjs'
const snapshot = { digest: 'same', dirty: [], files: { 'packages/a/src/unused.ts': 'hash' } }
const review = {
  schema: 1,
  snapshot: 'same',
  items: [
    {
      file: 'packages/a/src/unused.ts',
      reason: 'confirmed retired internal stub',
      checks: { publicContract: true, dynamicEntrypoints: true, consumers: true }
    }
  ]
}
const scan = { stages: ['all', 'deep'], snapshot }
const regular = () => ({ regular: true, symlink: false })
test('explicit current reviewed manifest is mandatory', () => {
  assert.throws(
    () => validateRemoval(['packages/a/src/unused.ts'], scan, snapshot, regular),
    /manifest/
  )
  assert.throws(
    () => validateRemoval({ ...review, snapshot: 'old' }, scan, snapshot, regular),
    /stale/
  )
  assert.throws(
    () => validateRemoval(review, { ...scan, stages: ['all'] }, snapshot, regular),
    /deep/
  )
  assert.throws(
    () =>
      validateRemoval(
        { ...review, items: [{ ...review.items[0], checks: {} }] },
        scan,
        snapshot,
        regular
      ),
    /review/
  )
})
test('dirty, untracked, symlink and protected targets reject the whole batch', () => {
  assert.throws(
    () => validateRemoval(review, scan, { ...snapshot, dirty: [review.items[0].file] }, regular),
    /dirty/
  )
  assert.throws(() => validateRemoval(review, scan, { ...snapshot, files: {} }, regular), /tracked/)
  assert.throws(
    () => validateRemoval(review, scan, snapshot, () => ({ regular: true, symlink: true })),
    /symlink/
  )
  for (const file of [
    'packages/onlyoffice-word/src/a.ts',
    'packages/a/../plugin-runtime/src/index.ts'
  ]) {
    assert.throws(
      () =>
        validateRemoval(
          { ...review, items: [{ ...review.items[0], file }] },
          scan,
          snapshot,
          regular
        ),
      /protected|canonical/
    )
  }
})
test('dry run does not delete; apply uses only fully validated paths', () => {
  const deleted = []
  const ports = { snapshot: () => snapshot, inspect: regular, remove: (file) => deleted.push(file) }
  assert.deepEqual(applyRemoval(review, scan, false, ports).wouldDelete, [review.items[0].file])
  assert.deepEqual(deleted, [])
  applyRemoval(review, scan, true, ports)
  assert.deepEqual(deleted, [review.items[0].file])
})

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { snapshotRepo } from '../../../profiles/action-driver/local-quality/native.mjs'
const project = path.resolve(import.meta.dirname, '../../..')
test('real CLI dry-run preserves file, apply deletes only reviewed fixture and refuses stale retry', () => {
  const parent = path.join(project, 'workbench/runs/test-fixtures/local-quality')
  fs.mkdirSync(parent, { recursive: true })
  const repo = fs.mkdtempSync(path.join(parent, 'cleanup-'))
  function write(file, content) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), content)
  }
  function run(command, args) {
    return spawnSync(command, args, { cwd: repo, encoding: 'utf8' })
  }
  try {
    write('package.json', '{"type":"module"}')
    write('.gitignore', 'artifacts/\n')
    write('packages/a/src/unused.ts', 'export const retired = true\n')
    write('packages/a/src/keep.ts', 'export const active = true\n')
    for (const file of [
      'scripts/audit-redundant/13-remove-proven.mjs',
      'scripts/audit-redundant/removal.mjs',
      'scripts/audit-redundant/lib.mjs',
      'scripts/local-quality/native.mjs'
    ])
      write(file, fs.readFileSync(path.join(project, file.replace(/^scripts\//,"profiles/action-driver/"))))
    assert.equal(run('git', ['init', '-q']).status, 0)
    assert.equal(run('git', ['add', '.']).status, 0)
    assert.equal(
      run('git', [
        '-c',
        'user.name=Quality Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--no-gpg-sign',
        '-qm',
        'fixture'
      ]).status,
      0
    )
    for(const name of ['toolchain.mjs','native-tools.mjs','native-tools.json'])write('scripts/'+name,fs.readFileSync(path.join(project,'profiles/action-driver',name)))
    const actual = snapshotRepo(repo)
    write(
      'artifacts/test-reports/redundant-code/run/scan.json',
      JSON.stringify({ snapshot: actual, stages: ['all', 'deep'] })
    )
    write(
      'artifacts/test-reports/redundant-code/run/reviewed.json',
      JSON.stringify({ ...review, snapshot: actual.digest })
    )
    const argv = [
      'scripts/audit-redundant/13-remove-proven.mjs',
      '--from=artifacts/test-reports/redundant-code/run/reviewed.json'
    ]
    const dry = run(process.execPath, argv)
    assert.equal(dry.status, 0, dry.stderr)
    assert.ok(fs.existsSync(path.join(repo, review.items[0].file)))
    const apply = run(process.execPath, [...argv, '--apply'])
    assert.equal(apply.status, 0, apply.stderr)
    assert.equal(fs.existsSync(path.join(repo, review.items[0].file)), false)
    assert.ok(fs.existsSync(path.join(repo, 'packages/a/src/keep.ts')))
    const retry = run(process.execPath, [...argv, '--apply'])
    assert.equal(retry.status, 2)
    assert.match(retry.stderr, /stale/)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('real all/deep pipeline uses one run, never promotes short stubs, rejects stale scan', () => {
  const parent = path.join(project, 'workbench/runs/test-fixtures/local-quality')
  fs.mkdirSync(parent, { recursive: true })
  const repo = fs.mkdtempSync(path.join(parent, 'pipeline-'))
  function write(file, content) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), content)
  }
  function run(args) {
    return spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8' })
  }
  function git(args) {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  try {
    write('package.json', '{"name":"fixture","type":"module","scripts":{}}')
    write('.gitignore', 'node_modules/\nartifacts/\n')
    write('packages/a/package.json', '{"name":"@fixture/a","exports":"./src/index.ts"}')
    write('packages/a/src/index.ts', 'export const active = true\n')
    write('packages/a/src/legacy.ts', '// Compatibility entry\nexport {}\n')
    for (const file of fs
      .readdirSync(path.join(project, 'profiles/action-driver/audit-redundant'))
      .filter((f) => f.endsWith('.mjs')))
      write(
        `scripts/audit-redundant/${file}`,
        fs.readFileSync(path.join(project, 'profiles/action-driver/audit-redundant', file))
      )
    write(
      'scripts/local-quality/native.mjs',
      fs.readFileSync(path.join(project, 'profiles/action-driver/local-quality/native.mjs'))
    )
    for(const name of ['toolchain.mjs','native-tools.mjs','native-tools.json'])write('scripts/'+name,fs.readFileSync(path.join(project,'profiles/action-driver',name)))
    fs.symlinkSync(path.join(project, 'node_modules'), path.join(repo, 'node_modules'), 'dir')
    git(['init', '-q'])
    git(['add', '.'])
    git([
      '-c',
      'user.name=Quality Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '-qm',
      'fixture'
    ])
    const out = 'artifacts/test-reports/redundant-code/run'
    const all = run(['scripts/audit-redundant/run-all.mjs', '--out', out])
    assert.equal(all.status, 0, all.stderr + all.stdout)
    const deep = run(['scripts/audit-redundant/run-deep.mjs', '--out', out])
    assert.equal(deep.status, 0, deep.stderr + deep.stdout)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, out, 'scan.json'))).stages, [
      'all',
      'deep'
    ])
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(repo, out, 'false-positive-refined.json')))
        .provenUnreachable,
      []
    )
    assert.equal(fs.existsSync(path.join(repo, 'scripts/audit-redundant/out')), false)
    write('packages/a/src/index.ts', 'export const changed = true\n')
    const stale = run(['scripts/audit-redundant/run-deep.mjs', '--out', out])
    assert.equal(stale.status, 2)
    assert.match(stale.stderr, /stale/)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
