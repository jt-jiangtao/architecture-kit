import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionForCandidate,
  buildCleanupLedger,
  validateCleanupDiff,
  validateCleanupLedger
} from '@architecture-kit/analyzers/audit/policy'

const snapshot = {
  digest: 'snapshot-a',
  inputs: { 'packages/a/src/unused.ts': 'hash-a' }
}

function candidate(overrides = {}) {
  return {
    id: 'C-001',
    kind: 'unused-file',
    level: 1,
    state: 'ready',
    targets: [{ file: 'packages/a/src/unused.ts' }],
    allowedChanges: [{ file: 'packages/a/src/unused.ts', kind: 'source', maxNetAdditions: 0 }],
    evidence: [{ source: 'audit', path: 'artifacts/audit.json', snapshot: snapshot.digest }],
    risk: { publicContract: false, dynamicEntrypoints: false, externalConsumers: false },
    review: { decision: 'pending', testDecision: 'unchanged' },
    ...overrides
  }
}

test('L1 cleanup is actionable when evidence and risk checks are complete', () => {
  assert.deepEqual(actionForCandidate(candidate()), { allowed: true, reasons: [] })
})

test('candidate risk can only reduce permissions', () => {
  const publicSurface = candidate({
    level: 3,
    state: 'review-required',
    risk: { publicContract: true, dynamicEntrypoints: false, externalConsumers: true }
  })
  assert.equal(actionForCandidate(publicSurface).allowed, false)
  assert.match(actionForCandidate(publicSurface).reasons.join('\n'), /approval/)

  const approved = {
    ...publicSurface,
    state: 'ready',
    evidence: [
      ...publicSurface.evidence,
      { source: 'human-approval', path: 'artifacts/approval.md', snapshot: snapshot.digest }
    ],
    review: { decision: 'approved', testDecision: 'unchanged' }
  }
  assert.equal(actionForCandidate(approved).allowed, true)
  assert.equal(actionForCandidate({ ...approved, level: 4, state: 'report-only' }).allowed, false)
})

test('L2 requires reference, impact and behavior evidence', () => {
  const structural = candidate({
    level: 2,
    kind: 'duplicate-implementation',
    state: 'evidence-required'
  })
  const missing = actionForCandidate(structural)
  assert.equal(missing.allowed, false)
  assert.match(missing.reasons.join('\n'), /serena.*ripwire.*behavior/i)

  const ready = {
    ...structural,
    state: 'ready',
    evidence: [
      { source: 'serena', detail: 'all references migrated', snapshot: snapshot.digest },
      { source: 'ripwire', path: 'artifacts/impact.json', snapshot: snapshot.digest },
      { source: 'behavior', path: 'artifacts/test.log', snapshot: snapshot.digest }
    ]
  }
  assert.equal(actionForCandidate(ready).allowed, true)
})

test('ledger binds candidates to one current workspace snapshot', () => {
  const ledger = buildCleanupLedger({
    runId: 'run-1',
    createdAt: '2026-10-31T00:00:00.000Z',
    snapshot,
    scope: ['packages/a'],
    toolRuns: [{ id: 'audit', status: 'success' }],
    debt: [],
    candidates: [candidate()]
  })
  assert.equal(validateCleanupLedger(ledger, { currentSnapshot: snapshot }).ok, true)
  const stale = validateCleanupLedger(ledger, {
    currentSnapshot: { ...snapshot, digest: 'changed' }
  })
  assert.equal(stale.ok, false)
  assert.match(stale.errors.join('\n'), /snapshot/)
})

test('cleanup diff rejects scope drift and unapproved production growth', () => {
  assert.equal(
    validateCleanupDiff(candidate(), [
      { file: 'packages/a/src/unused.ts', additions: 0, deletions: 8 }
    ]).ok,
    true
  )
  const outside = validateCleanupDiff(candidate(), [
    { file: 'packages/a/src/keep.ts', additions: 0, deletions: 2 }
  ])
  assert.equal(outside.ok, false)
  assert.match(outside.errors.join('\n'), /scope/)

  const growth = validateCleanupDiff(candidate(), [
    { file: 'packages/a/src/unused.ts', additions: 3, deletions: 1 }
  ])
  assert.equal(growth.ok, false)
  assert.match(growth.errors.join('\n'), /addition/)
})

test('test changes require an explicit integrity decision', () => {
  const withTest = candidate({
    allowedChanges: [
      { file: 'packages/a/src/unused.ts', kind: 'source', maxNetAdditions: 0 },
      { file: 'packages/a/tests/unused.test.ts', kind: 'test', maxNetAdditions: 5 }
    ]
  })
  const unreviewed = validateCleanupDiff(withTest, [
    { file: 'packages/a/tests/unused.test.ts', additions: 1, deletions: 2 }
  ])
  assert.equal(unreviewed.ok, false)
  assert.match(unreviewed.errors.join('\n'), /testDecision/)

  const reviewed = validateCleanupDiff(
    { ...withTest, review: { ...withTest.review, testDecision: 'delete-obsolete' } },
    [{ file: 'packages/a/tests/unused.test.ts', additions: 1, deletions: 2 }]
  )
  assert.equal(reviewed.ok, true)
})

test('no actual cleanup diff cannot be marked verified', () => {
  const empty = validateCleanupDiff(candidate(), [])
  assert.equal(empty.ok, false)
  assert.match(empty.errors.join('\n'), /no changed/)
})
