import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  validateRemoval,
  applyRemoval,
  snapshotRepo,
  runAuditStage
} from '@architecture-kit/analyzers'
import { deleteDenyPatterns } from '@architecture-kit/profile-action-driver'

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
    () => validateRemoval(['packages/a/src/unused.ts'], scan, snapshot, regular, deleteDenyPatterns),
    /manifest/
  )
  assert.throws(
    () => validateRemoval({ ...review, snapshot: 'old' }, scan, snapshot, regular, deleteDenyPatterns),
    /stale/
  )
  assert.throws(
    () => validateRemoval(review, { ...scan, stages: ['all'] }, snapshot, regular, deleteDenyPatterns),
    /deep/
  )
  assert.throws(
    () =>
      validateRemoval(
        { ...review, items: [{ ...review.items[0], checks: {} }] },
        scan,
        snapshot,
        regular,
        deleteDenyPatterns
      ),
    /review/
  )
})

test('dirty, untracked, symlink and protected targets reject the whole batch', () => {
  assert.throws(
    () =>
      validateRemoval(
        review,
        scan,
        { ...snapshot, dirty: [review.items[0].file] },
        regular,
        deleteDenyPatterns
      ),
    /dirty/
  )
  assert.throws(
    () => validateRemoval(review, scan, { ...snapshot, files: {} }, regular, deleteDenyPatterns),
    /tracked/
  )
  assert.throws(
    () =>
      validateRemoval(
        review,
        scan,
        snapshot,
        () => ({ regular: true, symlink: true }),
        deleteDenyPatterns
      ),
    /symlink/
  )
  for (const file of [
    'packages/office/onlyoffice-word/src/a.ts',
    'packages/plugins/plugin-runtime/src/index.ts',
    'packages/computer-use/browser-runtime/src/auth/broker.ts',
    'packages/a/../plugin-runtime/src/index.ts'
  ]) {
    assert.throws(
      () =>
        validateRemoval(
          { ...review, items: [{ ...review.items[0], file }] },
          scan,
          snapshot,
          regular,
          deleteDenyPatterns
        ),
      /protected|canonical/
    )
  }
})

test('dry run does not delete; apply uses only fully validated paths', () => {
  const deleted = []
  const ports = { snapshot: () => snapshot, inspect: regular, remove: (file) => deleted.push(file) }
  assert.deepEqual(applyRemoval(review, scan, false, ports, deleteDenyPatterns).wouldDelete, [
    review.items[0].file
  ])
  assert.deepEqual(deleted, [])
  applyRemoval(review, scan, true, ports, deleteDenyPatterns)
  assert.deepEqual(deleted, [review.items[0].file])
})

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
    const actual = snapshotRepo(repo)
    const scanRecord = { snapshot: actual, stages: ['all', 'deep'] }
    const manifestRecord = { ...review, snapshot: actual.digest }
    write(
      'artifacts/test-reports/redundant-code/run/scan.json',
      JSON.stringify(scanRecord)
    )
    write(
      'artifacts/test-reports/redundant-code/run/reviewed.json',
      JSON.stringify(manifestRecord)
    )
    const ports = {
      snapshot: () => snapshotRepo(repo),
      inspect: (rel) => {
        const abs = path.join(repo, rel)
        const st = fs.lstatSync(abs)
        return {
          regular: st.isFile(),
          symlink: st.isSymbolicLink() || fs.realpathSync(abs) !== abs
        }
      },
      remove: (rel) => fs.unlinkSync(path.join(repo, rel))
    }
    const dry = applyRemoval(manifestRecord, scanRecord, false, ports, deleteDenyPatterns)
    assert.equal(dry.mode, 'dry-run')
    assert.ok(fs.existsSync(path.join(repo, review.items[0].file)))
    const applied = applyRemoval(manifestRecord, scanRecord, true, ports, deleteDenyPatterns)
    assert.equal(applied.mode, 'apply')
    assert.equal(fs.existsSync(path.join(repo, review.items[0].file)), false)
    assert.ok(fs.existsSync(path.join(repo, 'packages/a/src/keep.ts')))
    assert.throws(
      () => applyRemoval(manifestRecord, scanRecord, true, ports, deleteDenyPatterns),
      /stale/
    )
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
    runAuditStage('all', repo, out)
    runAuditStage('deep', repo, out)
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
    assert.throws(() => runAuditStage('deep', repo, out), /stale/)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
