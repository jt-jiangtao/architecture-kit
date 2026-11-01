import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  deleteFile,
  prepareCleanup,
  readDiffStats,
  verifyCleanup
} from '../../../profiles/action-driver/audit-redundant/cleanup-pipeline.mjs'

const project = path.resolve(import.meta.dirname, '../../..')

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function fixture() {
  const parent = path.join(project, 'workbench/runs/test-fixtures/local-quality')
  fs.mkdirSync(parent, { recursive: true })
  return fs.mkdtempSync(path.join(parent, 'cleanup-pipeline-'))
}

function result(id, findings = [], extra = {}) {
  return {
    id,
    execution: 'success',
    verdict: findings.length ? 'review' : 'pass',
    findings,
    required: true,
    ...extra
  }
}

test('diff stats count a directory symlink as one changed entry', (t) => {
  const root = fixture()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'skill'))
  fs.symlinkSync('skill', path.join(root, 'skill-link'), 'dir')
  assert.deepEqual(readDiffStats(root, ['skill-link']), [
    { file: 'skill-link', additions: 1, deletions: 0 }
  ])
})

test('prepare and verify produce a run-bound L1 cleanup record', async () => {
  const root = fixture()
  const out = 'artifacts/test-reports/redundant-code/run'
  const snapshot = {
    digest: 'base-snapshot',
    head: 'abc',
    files: { 'packages/a/src/dead.ts': 'base-hash' },
    inputs: { 'packages/a/src/dead.ts': 'base-hash' }
  }
  fs.mkdirSync(path.join(root, 'packages/a/src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'packages/a/src/one.ts'), 'export const one = 1\n')
  fs.writeFileSync(path.join(root, 'packages/a/src/two.ts'), 'export const two = 2\n')
  const execute = (command) => {
    if (command.some((part) => part.includes('run-all.mjs') || part.includes('run-deep.mjs'))) {
      const runDir = path.join(root, command[command.indexOf('--out') + 1])
      const scanFile = path.join(runDir, 'scan.json')
      if (fs.existsSync(scanFile)) {
        const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'))
        scan.stages = ['all', 'deep']
        writeJson(scanFile, scan)
      } else {
        writeJson(scanFile, { schema: 1, snapshot, stages: ['all'] })
      }
      writeJson(path.join(runDir, 'false-positive-refined.json'), {
        provenUnreachable: ['packages/a/src/dead.ts']
      })
      writeJson(path.join(runDir, 'symbol-dead-code.json'), { deadValueExports: [] })
      writeJson(path.join(runDir, 'dead-tests.json'), {
        brokenImports: [],
        unreferencedFixtures: []
      })
    } else if (command.some((part) => part.includes('local-quality/run.mjs'))) {
      const runDir = path.join(root, command[command.indexOf('--out') + 1])
      const duplicate = {
        format: 'typescript',
        firstFile: { name: 'a/src/one.ts' },
        secondFile: { name: 'a/src/two.ts' }
      }
      writeJson(path.join(runDir, 'results.json'), {
        results: [
          result('knip', ['unused-file:packages/a/src/knip-dead.ts', 'packages/a/src/one.ts:types:Both']),
          result('knip-production', ['unused-file:packages/a/src/test-used.ts', 'packages/a/src/one.ts:types:Both', 'packages/a/src/one.ts:types:TestOnly']),
          result('jscpd', [JSON.stringify(duplicate)], {
            report: path.join(
              root,
              command[command.indexOf('--out') + 1],
              'jscpd/jscpd-report.json'
            )
          })
        ]
      })
      writeJson(path.join(runDir, 'jscpd/jscpd-report.json'), {
        duplicates: [duplicate]
      })
      return {
        code: command.includes('--only') ? 1 : 0,
        stdout: '',
        stderr: '',
        error: undefined
      }
    }
    return { code: 0, stdout: '', stderr: '', error: undefined }
  }

  try {
    const prepared = await prepareCleanup({
      root,
      out,
      now: new Date('2026-10-31T00:00:00Z'),
      ports: { snapshot: () => snapshot, execute }
    })
    assert.equal(prepared.exitCode, 0)
    assert.equal(prepared.ledger.candidates[0].level, 1)
    assert.equal(prepared.ledger.candidates[0].state, 'ready')
    assert.ok(prepared.ledger.candidates.some((item) => item.kind === 'knip-unused-file'))
    const productionOnly = prepared.ledger.candidates.filter(item => item.targets.some(target => target.file === 'packages/a/src/test-used.ts'))
    assert.equal(productionOnly.length, 1)
    assert.equal(productionOnly[0].level, 2)
    assert.equal(productionOnly[0].targets[0].symbol, undefined)
    assert.ok(prepared.ledger.candidates.some((item) => item.kind === 'duplicate-code'))

    const ledgerFile = path.join(root, out, 'cleanup-ledger.json')
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    const modes = name => ledger.candidates.find(c => c.targets.some(t => t.symbol === name)).evidence.map(item => item.mode)
    assert.deepEqual(modes('Both'), ['default', 'production'])
    assert.deepEqual(modes('TestOnly'), ['production'])
    const candidate = ledger.candidates[0]
    candidate.allowedChanges = [
      { file: 'packages/a/src/dead.ts', kind: 'source', maxNetAdditions: 0 }
    ]
    writeJson(ledgerFile, ledger)
    writeJson(path.join(root, 'packages/a/package.json'), {
      name: '@fixture/a',
      type: 'module'
    })
    fs.mkdirSync(path.join(root, 'packages/a/src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'packages/a/src/dead.ts'), 'export const retired = true\n')

    const current = {
      ...snapshot,
      digest: 'changed-snapshot',
      inputs: { 'packages/a/src/dead.ts': 'changed-hash' }
    }
    fs.mkdirSync(path.join(root,'packages/a/tests'),{recursive:true})
    fs.writeFileSync(path.join(root,'packages/a/tests/dead.test.ts'),'export {}')
    const verified = await verifyCleanup({
      root,
      run: out,
      candidateId: candidate.id,
      tests: ['packages/a/tests/dead.test.ts'],
      now: new Date('2026-10-31T01:00:00Z'),
      ports: {
        snapshot: () => current,
        diffStats: () => [{ file: 'packages/a/src/dead.ts', additions: 0, deletions: 4 }],
        execute
      }
    })
    assert.equal(verified.ok, true)
    assert.ok(verified.checks.some((check) => check.id === 'related-tests'))
    const updated = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    assert.equal(updated.candidates[0].state, 'verified')
    assert.equal(updated.candidates[0].verification.ok, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('missing optional structural tool blocks verification instead of scoring success', async () => {
  const root = fixture()
  const out = 'artifacts/test-reports/redundant-code/run'
  const snapshot = {
    digest: 'base',
    files: { 'packages/a/src/dead.ts': 'a' },
    inputs: { 'packages/a/src/dead.ts': 'a' }
  }
  const execute = (command) => {
    if(command[0]==='ast-grep')return {code:null,error:'ENOENT',stdout:'',stderr:''}
    if (command.some((part) => part.includes('run-all.mjs') || part.includes('run-deep.mjs'))) {
      const runDir = path.join(root, command[command.indexOf('--out') + 1])
      const scanFile = path.join(runDir, 'scan.json')
      if (fs.existsSync(scanFile)) {
        const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'))
        scan.stages = ['all', 'deep']
        writeJson(scanFile, scan)
      } else {
        writeJson(scanFile, { schema: 1, snapshot, stages: ['all'] })
      }
      writeJson(path.join(runDir, 'false-positive-refined.json'), {
        provenUnreachable: ['packages/a/src/dead.ts']
      })
      writeJson(path.join(runDir, 'symbol-dead-code.json'), {})
      writeJson(path.join(runDir, 'dead-tests.json'), {})
    } else if (command[0] === 'ast-grep') {
      return { code: null, stdout: '', stderr: '', error: 'spawnSync ast-grep ENOENT' }
    } else if (command.some((part) => part.includes('local-quality/run.mjs'))) {
      const runDir = path.join(root, command[command.indexOf('--out') + 1])
      writeJson(path.join(runDir, 'results.json'), {
        results: [result('knip'), result('knip-production'), result('jscpd')]
      })
    }
    return { code: 0, stdout: '', stderr: '', error: undefined }
  }

  try {
    await prepareCleanup({
      root,
      out,
      now: new Date('2026-10-31T00:00:00Z'),
      ports: { snapshot: () => snapshot, execute }
    })
    const ledgerFile = path.join(root, out, 'cleanup-ledger.json')
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    ledger.candidates[0].tools = { astGrep: 'cleanup.yml' }
    writeJson(ledgerFile, ledger)
    writeJson(path.join(root, 'packages/a/package.json'), {
      name: '@fixture/a',
      type: 'module'
    })
    fs.mkdirSync(path.join(root, 'packages/a/src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'packages/a/src/dead.ts'), 'export const retired = true\n')

    const current = {
      ...snapshot,
      digest: 'changed',
      inputs: { 'packages/a/src/dead.ts': 'changed' }
    }
    const verified = await verifyCleanup({
      root,
      run: out,
      candidateId: ledger.candidates[0].id,
      ports: {
        snapshot: () => current,
        diffStats: () => [{ file: 'packages/a/src/dead.ts', additions: 0, deletions: 2 }],
        execute
      }
    })
    assert.equal(verified.ok, false)
    assert.match(verified.evidenceGaps.map((gap) => gap.source).join(','), /ast-grep/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('whole-file cleanup routes through existing review and dry-run commands', async () => {
  const root = fixture()
  const run = 'artifacts/test-reports/redundant-code/run'
  fs.mkdirSync(path.join(root, run), { recursive: true })
  writeJson(path.join(root, run, 'scan.json'), {
    schema: 1,
    snapshot: { digest: 'snapshot-a' },
    stages: ['all', 'deep']
  })
  writeJson(path.join(root, run, 'cleanup-ledger.json'), {
    schemaVersion: 1,
    runId: 'run',
    snapshot: { digest: 'snapshot-a' },
    candidates: [
      {
        id: 'C-FILE',
        level: 1,
        state: 'ready',
        snapshot: 'snapshot-a',
        targets: [{ file: 'packages/a/src/dead.ts' }],
        allowedChanges: [{ file: 'packages/a/src/dead.ts', kind: 'source', maxNetAdditions: 0 }],
        evidence: [{ source: 'audit', snapshot: 'snapshot-a' }],
        risk: {
          publicContract: false,
          dynamicEntrypoints: false,
          externalConsumers: false
        },
        review: {
          deletionReviewed: true,
          publicContractReviewed: true,
          dynamicEntrypointsReviewed: true,
          consumersReviewed: true
        }
      }
    ]
  })
  const calls = []
  const execute = (command) => {
    calls.push(command)
    if (command.some((part) => part.includes('prepare-review.mjs')))
      return { code: 0, stdout: '', stderr: '', error: undefined }
    return {
      code: 0,
      stdout: JSON.stringify({ mode: 'dry-run', wouldDelete: ['packages/a/src/dead.ts'] }),
      stderr: '',
      error: undefined
    }
  }
  try {
    const result = await deleteFile({
      root,
      run,
      candidate: 'C-FILE',
      execute
    })
    assert.deepEqual(result.wouldDelete, ['packages/a/src/dead.ts'])
    assert.equal(calls.length, 2)
    assert.match(calls[0].join(' '), /prepare-review\.mjs/)
    assert.match(calls[1].join(' '), /13-remove-proven\.mjs.*--dry-run/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
