import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assessCleanupVerification,
  buildCleanupLedger,
  buildDeletionDecision,
  buildEvidenceGap,
  extractCounterexample,
  normalizeJscpdDuplicates
} from '../../../profiles/action-driver/audit-redundant/cleanup-pipeline.mjs'

const snapshot = {
  digest: 'snapshot-a',
  inputs: { 'packages/a/src/index.ts': 'hash-a' }
}

test('ledger generation classifies static candidates without approving high-risk work', () => {
  const ledger = buildCleanupLedger({
    runId: 'cleanup-run',
    createdAt: '2026-10-31T00:00:00.000Z',
    snapshot,
    scope: ['packages/a'],
    toolRuns: [{ id: 'audit', status: 'success' }],
    debt: [],
    reports: {
      audit: {
        provenUnreachable: ['packages/a/src/dead.ts'],
        likelyUnused: [{ file: 'packages/a/src/legacy.ts' }]
      },
      symbols: {
        deadValueExports: [
          { name: 'legacyApi', file: 'packages/a/src/index.ts', line: 12, kind: 'function' }
        ]
      },
      deadTests: { brokenImports: [], unreferencedFixtures: [] },
      knip: { files: ['packages/a/src/unused.ts'], issues: [] },
      jscpd: { duplicates: [] }
    }
  })

  const byKind = Object.fromEntries(ledger.candidates.map((item) => [item.kind, item]))
  assert.equal(byKind['unreachable-file'].level, 1)
  assert.equal(byKind['likely-unused-file'].level, 2)
  assert.equal(byKind['dead-export'].level, 3)
  assert.equal(byKind['knip-unused-file'].level, 1)
  assert.equal(
    ledger.candidates.some((item) => item.state === 'report-only'),
    false
  )
  assert.ok(ledger.candidates.every((item) => item.snapshot === snapshot.digest))
})

test('candidate identity keeps distinct symbols and Knip issue categories in the same file', () => {
  const ledger = buildCleanupLedger({
    runId: 'cleanup-distinct',
    createdAt: '2026-10-31T00:00:00.000Z',
    snapshot,
    scope: ['packages/a'],
    toolRuns: [{ id: 'audit', status: 'success' }],
    debt: [],
    reports: {
      audit: {},
      symbols: {
        deadValueExports: [
          { name: 'oldOne', file: 'packages/a/src/index.ts', line: 1, kind: 'function' },
          { name: 'oldTwo', file: 'packages/a/src/index.ts', line: 2, kind: 'function' }
        ]
      },
      deadTests: {},
      knip: {
        files: [],
        issues: [
          { file: 'packages/a/src/index.ts', category: 'exports', value: 'unusedA' },
          { file: 'packages/a/src/index.ts', category: 'exports', value: 'unusedB' },
          { file: 'packages/a/package.json', category: 'dependencies', value: 'left-pad' },
          { file: 'packages/a/package.json', category: 'devDependencies', value: 'vitest' },
          { file: 'packages/a/src/index.ts', category: 'duplicates', value: 'duplicateExport' }
        ]
      },
      jscpd: { duplicates: [] }
    }
  })

  const deadExports = ledger.candidates.filter((item) => item.kind === 'dead-export')
  assert.equal(deadExports.length, 2)
  assert.deepEqual(deadExports.map((item) => item.targets[0].symbol).sort(), ['oldOne', 'oldTwo'])
  const dependencies = ledger.candidates.filter((item) => item.kind === 'knip-unused-dependency')
  assert.equal(dependencies.length, 2)
  assert.deepEqual(dependencies.map((item) => item.targets[0].symbol).sort(), [
    'left-pad',
    'vitest'
  ])
  assert.equal(ledger.candidates.filter((item) => item.kind === 'knip-unused-export').length, 2)
  assert.equal(ledger.candidates.filter((item) => item.kind === 'knip-duplicate-export').length, 1)
})

test('jscpd normalization restores workspace roots and drops ambiguous paths', () => {
  const mapped = new Map([
    ['cloud-service/src/a.ts', 'apps/cloud-service/src/a.ts'],
    ['skills/src/b.ts', 'plugins/skills/src/b.ts']
  ])
  const result = normalizeJscpdDuplicates(
    [
      {
        format: 'typescript',
        firstFile: { name: 'cloud-service/src/a.ts' },
        secondFile: { name: 'skills/src/b.ts' }
      },
      {
        format: 'typescript',
        firstFile: { name: 'unknown/src/a.ts' },
        secondFile: { name: 'skills/src/b.ts' }
      }
    ],
    (file) => mapped.get(file) || null
  )
  assert.equal(result.duplicates.length, 1)
  assert.deepEqual(
    [result.duplicates[0].firstFile.name, result.duplicates[0].secondFile.name],
    ['apps/cloud-service/src/a.ts', 'plugins/skills/src/b.ts']
  )
  assert.equal(result.unresolved.length, 1)
})

test('verification combines diff, checks and counterexample rather than trusting CI alone', () => {
  const passing = assessCleanupVerification({
    change: { ok: true, errors: [] },
    checks: [{ id: 'related-tests', status: 'success' }],
    counterexample: null,
    evidenceGaps: []
  })
  assert.equal(passing.ok, true)

  const failedProperty = assessCleanupVerification({
    change: { ok: true, errors: [] },
    checks: [{ id: 'related-tests', status: 'success' }],
    counterexample: 'expected 1, received 2',
    evidenceGaps: []
  })
  assert.equal(failedProperty.ok, false)
  assert.match(failedProperty.errors.join('\n'), /counterexample/)
})

test('counterexample extraction preserves fast-check repro information', () => {
  const text = ['Counterexample: [1, 2, 3]', 'Shrunk 4 time(s)', 'seed: 1234', 'path: 0:1:2'].join(
    '\n'
  )
  const result = extractCounterexample(text)
  assert.match(result, /\[1, 2, 3\]/)
  assert.match(result, /seed/)
})

test('optional tool absence is a gap, not a fallback deletion signal', () => {
  assert.deepEqual(buildEvidenceGap('ast-grep', 'ENOENT'), {
    source: 'ast-grep',
    status: 'missing',
    detail: 'ENOENT'
  })
})

test('whole-file deletion still requires the existing review booleans', () => {
  const base = {
    id: 'C-FILE',
    kind: 'unreachable-file',
    level: 1,
    targets: [{ file: 'packages/a/src/dead.ts' }],
    evidence: [{ source: 'audit', path: 'artifacts/audit.json', snapshot: 'snapshot-a' }],
    allowedChanges: [{ file: 'packages/a/src/dead.ts', kind: 'source', maxNetAdditions: 0 }],
    risk: { publicContract: false, dynamicEntrypoints: false, externalConsumers: false },
    review: { decision: 'pending' }
  }
  assert.equal(buildDeletionDecision(base), null)
  const reviewed = {
    ...base,
    review: {
      decision: 'pending',
      deletionReviewed: true,
      publicContractReviewed: true,
      dynamicEntrypointsReviewed: true,
      consumersReviewed: true
    }
  }
  assert.deepEqual(buildDeletionDecision(reviewed), {
    file: 'packages/a/src/dead.ts',
    reason: 'cleanup candidate C-FILE reviewed as a retired file',
    checks: { publicContract: true, dynamicEntrypoints: true, consumers: true }
  })
})
