import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, runChecks, compareBaseline } from '../../../profiles/action-driver/local-quality/engine.mjs'
import { createPlan } from '../../../profiles/action-driver/local-quality/plan.mjs'

const command = {
  id: 'knip',
  tool: 'knip',
  command: ['pnpm', 'exec', 'knip'],
  parser: 'knip',
  required: true,
  scope: ['packages/a']
}
const result = (code, stdout) => ({ code, stdout, stderr: '', version: '1.0' })
test('Knip findings, crashes and malformed evidence are distinct', () => {
  assert.equal(classify(command, result(1, '{"files":["a.ts"],"issues":[]}')).verdict, 'findings')
  assert.equal(classify(command, result(2, '{}')).execution, 'error')
  assert.equal(classify(command, result(0, 'not-json')).execution, 'error')
  assert.equal(classify(command, result(0, '{}')).execution, 'error')
  assert.equal(classify(command, result(0, '{"files":[],"issues":[]}')).verdict, 'pass')
})
test('Knip 6 file observations preserve whole-file identity', () => {
  const file = 'packages/a/src/unused.ts'
  const row = classify(command, result(1, JSON.stringify({ issues: [{ file, files: [{ name: file }] }] })))
  assert.deepEqual(row.findings, ['unused-file:' + file])
  const invalid = classify(command, result(1, JSON.stringify({ issues: [{ file, files: [{ name: 'other.ts' }] }] })))
  assert.equal(invalid.execution, 'error')
})
test('report generation never means no candidates; duplicate source is review', () => {
  assert.equal(
    classify(
      { ...command, parser: 'jscpd' },
      result(0, '{"duplicates":[{"firstFile":{"name":"a.ts"}}]}')
    ).verdict,
    'review'
  )
})
test('failed prerequisites skip dependents and source mutation invalidates evidence', async () => {
  const calls = []
  let count = 0
  const report = await runChecks(
    [
      { ...command, id: 'all', parser: 'exit' },
      { ...command, id: 'deep', dependsOn: ['all'] },
      { ...command, id: 'independent', parser: 'exit' }
    ],
    {
      snapshot: () => ({ digest: ++count === 1 ? 'before' : 'after' }),
      now: () => '2026-10-30T00:00:00.000Z',
      execute: async (check) => {
        calls.push(check.id)
        return result(check.id === 'all' ? 2 : 0, '')
      },
      save: () => {}
    }
  )
  assert.deepEqual(calls, ['all', 'independent'])
  assert.equal(report.results[1].execution, 'skipped')
  assert.equal(report.evidenceValid, false)
  assert.equal(report.exitCode, 2)
})
test('missing required release evidence cannot pass', async () => {
  const report = await runChecks(
    [{ id: 'host', required: true, scope: [], pending: 'host evidence required' }],
    {
      snapshot: () => ({ digest: 'same' }),
      now: () => 'now',
      execute: () => {
        throw new Error('must not execute')
      },
      save: () => {}
    }
  )
  assert.equal(report.exitCode, 2)
  assert.equal(report.results[0].execution, 'skipped')
})
test('baseline comparison never silently accepts new or old issues and requires matching coverage', () => {
  const current = { scope: ['a'], toolVersion: '1', configDigest: 'cfg', findings: ['old', 'new'] }
  assert.deepEqual(compareBaseline(current, { ...current, findings: ['old', 'gone'] }), {
    comparable: true,
    added: ['new'],
    existing: ['old'],
    resolved: ['gone']
  })
  assert.equal(compareBaseline(current, { ...current, scope: ['b'] }).comparable, false)
})
test('plans deduplicate lint/config, omit madge/OSV by default, require release behavior evidence', () => {
  const full = createPlan({
    mode: 'full',
    files: [],
    packages: [],
    out: 'artifacts/test-reports/run'
  })
  assert.equal(full.filter((c) => c.id === 'eslint').length, 1)
  assert.equal(
    full.some((c) => JSON.stringify(c).includes('madge')),
    false
  )
  assert.equal(
    full.some((c) => c.id === 'osv'),
    false
  )
  assert.equal(full.filter((c) => c.id === 'config').length, 1)
  assert.ok(full.some((c) => c.id === 'knip-production'))
  const release = createPlan({
    mode: 'release',
    files: [],
    packages: [],
    out: 'artifacts/test-reports/run'
  })
  assert.ok(release.some((c) => c.id === 'release-evidence' && c.pending))
  assert.equal(
    release.some((c) => c.command?.join(' ') === 'pnpm test'),
    false
  )
})
test('incremental selection includes reverse consumers but not unrelated packages', () => {
  const packages = [
    { dir: 'packages/a', name: 'a', dependencies: [] },
    { dir: 'apps/b', name: 'b', dependencies: ['a'] },
    { dir: 'apps/c', name: 'c', dependencies: [] }
  ]
  const plan = createPlan({
    mode: 'pr',
    files: ['packages/a/src/a.ts'],
    packages,
    out: 'artifacts/test-reports/run'
  })
  assert.deepEqual(plan.find((c) => c.id === 'typecheck').scope, ['packages/a', 'apps/b'])
})

test('installed Knip issues-only JSON is accepted; unknown report is rejected', () => {
  assert.equal(classify(command, result(0, '{"issues":[]}')).verdict, 'pass')
  assert.equal(
    classify(command, result(1, '{"issues":[{"file":"a.ts","files":[{"name":"a.ts"}]}]}')).verdict,
    'findings'
  )
  assert.equal(
    classify({ ...command, parser: 'pnpm-audit' }, result(1, '{"error":{"code":"ENOTFOUND"}}'))
      .execution,
    'error'
  )
  assert.equal(
    classify({ ...command, parser: 'gitleaks' }, { ...result(0, ''), report: null }).execution,
    'error'
  )
})
test('exit-only results and missing versions cannot claim comparable issue identities', () => {
  const current = {
    scope: ['a'],
    toolVersion: '1',
    configDigest: 'cfg',
    findings: ['old'],
    findingsComparable: false
  }
  assert.equal(compareBaseline(current, current).comparable, false)
  assert.equal(compareBaseline({ ...current, toolVersion: null }, current).comparable, false)
})

test('nested independent targets select executable checks without becoming workspace packages', () => {
  const plan = createPlan({
    mode: 'pr', files: ['apps/linux-desktop/media/src/server.mjs'], packages: [],
    targets: [{ id: 'media', root: 'apps/linux-desktop/media', triggers: ['apps/linux-desktop/media/**'], dependencies: [],
      checks: [{ id: 'syntax', command: ['node', '--check', 'src/server.mjs'], cwd: 'apps/linux-desktop/media' }] }],
    out: 'artifacts/test-reports/run'
  })
  const check = plan.find(item => item.id === 'target:media:syntax')
  assert.ok(check)
  assert.deepEqual(check.command, ['node', '--check', 'src/server.mjs'])
  assert.equal(check.cwd, 'apps/linux-desktop/media')
  assert.equal(plan.some(item => item.id === 'typecheck'), false)
})

test('independent consumers are selected by shared contracts and deployment recipe changes', () => {
  const targets = [{ id: 'media', root: 'apps/linux-desktop/media', dependencies: ['protocol'],
    triggers: ['apps/linux-desktop/media/**', 'deploy/linux-desktop/compose*.yaml'],
    checks: [{ id: 'syntax', command: ['node', '--check', 'server.mjs'] }] }]
  for (const file of ['packages/protocol/src/index.ts', 'deploy/linux-desktop/compose.cloud.yaml']) {
    const plan = createPlan({ mode: 'pr', files: [file], targets,
      packages: [{ name: 'protocol', dir: 'packages/protocol', dependencies: [] }], out: 'artifacts/test-reports/run' })
    assert.ok(plan.some(item => item.id === 'target:media:syntax'), file)
  }
})

test('unknown application source and targets without checks report required coverage gaps', () => {
  const unknown = createPlan({ mode: 'pr', files: ['apps/unregistered/nested/src/main.py'], packages: [], out: 'artifacts/test-reports/run' })
  assert.ok(unknown.some(item => item.id === 'unowned-targets' && item.pending && item.required))
  const full = createPlan({ mode: 'full', files: [], packages: [],
    targets: [{ id: 'gateway', root: 'apps/office-mcp/gateway', triggers: [], dependencies: [], checks: [] }],
    out: 'artifacts/test-reports/run' })
  assert.ok(full.some(item => item.id === 'target:gateway:coverage' && item.pending && item.required))
})

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createNativePorts, snapshotRepo } from '../../../profiles/action-driver/local-quality/native.mjs'
test('native execution writes a valid read-only report and preserves source bytes', async () => {
  const parent = path.resolve(
    import.meta.dirname,
    '../../../workbench/runs/test-fixtures/local-quality'
  )
  fs.mkdirSync(parent, { recursive: true })
  const repo = fs.mkdtempSync(path.join(parent, 'quality-'))
  function git(args) {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  try {
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture","type":"module"}')
    fs.writeFileSync(path.join(repo, 'source.ts'), 'export const value = 1\n')
    fs.writeFileSync(path.join(repo, '.gitignore'), 'artifacts/\n')
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
    const before = snapshotRepo(repo)
    const out = path.join(repo, 'artifacts/test-reports/run')
    fs.mkdirSync(out, { recursive: true })
    const report = await runChecks(
      [
        {
          ...command,
          tool: 'node',
          command: [process.execPath, '-e', 'console.log(JSON.stringify({issues:[]}))']
        }
      ],
      createNativePorts(repo, out)
    )
    assert.equal(report.exitCode, 0)
    assert.equal(report.evidenceValid, true)
    assert.equal(snapshotRepo(repo).digest, before.digest)
    assert.equal(fs.readFileSync(path.join(repo, 'source.ts'), 'utf8'), 'export const value = 1\n')
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'knip.json'))).verdict, 'pass')
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('package manager execution blockers are not quality findings', () => {
  assert.equal(
    classify({ ...command, parser: 'exit' }, { ...result(1, ''), stderr: 'ERR_PNPM_TASK_CYCLE' })
      .execution,
    'error'
  )
})

test('workspace dependency rule detects actual cycles beyond the previous narrow scope', () => {
  const project = path.resolve(import.meta.dirname, '../../..')
  const parent = path.join(project, 'workbench/runs/test-fixtures/local-quality')
  fs.mkdirSync(parent, { recursive: true })
  const repo = fs.mkdtempSync(path.join(parent, 'boundaries-'))
  try {
    fs.mkdirSync(path.join(repo, 'packages/example/src'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, 'packages/example/src/a.ts'),
      "import { b } from './b'; export const a = () => b()\n"
    )
    fs.writeFileSync(
      path.join(repo, 'packages/example/src/b.ts'),
      "import { a } from './a'; export const b = () => a()\n"
    )
    fs.writeFileSync(path.join(repo,'dependency-cruiser.config.cjs'),"module.exports={forbidden:[{name:'workspace-no-cycles',severity:'error',from:{},to:{circular:true}}],options:{}}")
    const r = spawnSync(
      path.join(project, 'node_modules/.bin/depcruise'),
      ['--config', path.join(repo, 'dependency-cruiser.config.cjs'), 'packages/example/src'],
      { cwd: repo, encoding: 'utf8' }
    )
    assert.equal(r.status, 1, r.stderr + r.stdout)
    assert.match(r.stdout + r.stderr, /workspace-no-cycles/)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('dependency-cruiser counts violations in its exit code, but malformed reports fail', () => {
  const check = { ...command, parser: 'dependency-cruiser' }
  const stdout = JSON.stringify({
    summary: { error: 33, violations: [{ from: 'a.ts', to: 'b.ts', rule: { name: 'cycle' } }] }
  })
  assert.equal(classify(check, result(33, stdout)).verdict, 'findings')
  assert.equal(classify(check, result(0, stdout)).verdict, 'findings')
  assert.equal(classify(check, result(33, '{}')).execution, 'error')
  assert.equal(classify(check, result(2, 'crashed')).execution, 'error')
})

import { scanWorkingTree } from '../../../profiles/action-driver/local-quality/working-tree-native.mjs'
test('secret scan copies only Git inputs, includes dirty/untracked files, and cleans its mirror', () => {
  const parent = path.resolve(
    import.meta.dirname,
    '../../../workbench/runs/test-fixtures/local-quality'
  )
  fs.mkdirSync(parent, { recursive: true })
  const repo = fs.mkdtempSync(path.join(parent, 'secrets-'))
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  try {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'artifacts/\nnode_modules/\nconfig/secrets/\n')
    fs.writeFileSync(path.join(repo, 'source.ts'), 'original')
    git(['init', '-q'])
    git(['add', '.'])
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--no-gpg-sign',
      '-qm',
      'fixture'
    ])
    fs.writeFileSync(path.join(repo, 'source.ts'), 'dirty')
    fs.writeFileSync(path.join(repo, 'new.ts'), 'new')
    fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules/ignored.js'), 'dependency')
    fs.symlinkSync('source.ts', path.join(repo, 'alias.ts'))
    const out = path.join(repo, 'artifacts/test-reports/run')
    fs.mkdirSync(out, { recursive: true })
    let mirror
    scanWorkingTree(repo, path.join(out, 'leaks.json'), (command, cwd) => {
      mirror = cwd
      assert.ok(command.includes('--redact'))
      assert.equal(fs.readFileSync(path.join(cwd, 'source.ts'), 'utf8'), 'dirty')
      assert.equal(fs.readFileSync(path.join(cwd, 'new.ts'), 'utf8'), 'new')
      assert.equal(fs.existsSync(path.join(cwd, 'node_modules')), false)
      assert.equal(fs.existsSync(path.join(cwd, 'alias.ts')), false)
      return { code: 0, stdout: '', stderr: '' }
    })
    assert.equal(fs.existsSync(mirror), false)
    assert.equal(fs.readFileSync(path.join(repo, 'source.ts'), 'utf8'), 'dirty')
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(out, 'leaks.json.scope.json'))).skippedSymlinks,
      ['alias.ts']
    )
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
