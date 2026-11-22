import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCleanupDebtMarkers,
  validateCleanupDebt
} from '@architecture-kit/analyzers/audit/debt'

function registry(overrides = {}) {
  return {
    schemaVersion: 1,
    items: [
      {
        id: 'CD-001',
        owner: 'runtime-team',
        reason: 'desktop clients are still migrating',
        targets: [{ file: 'packages/a/src/adapter.ts', symbol: 'LegacyAdapter' }],
        removeWhen: 'all supported clients use protocol v2',
        replacement: 'NewAdapter',
        createdAt: '2026-01-01',
        expiresAt: '2026-12-31',
        evidence: ['issue-42']
      }
    ],
    ...overrides
  }
}

const markers = { 'packages/a/src/adapter.ts': ['CD-001'] }
const now = new Date('2026-10-31T00:00:00.000Z')

test('active cleanup debt validates and stays non-actionable', () => {
  const result = validateCleanupDebt(registry(), { now, markers })
  assert.equal(result.ok, true)
  assert.deepEqual(result.actionable, [])
})

test('expired untouched debt becomes L3 while changed expired debt fails', () => {
  const expired = registry({
    items: [{ ...registry().items[0], expiresAt: '2026-09-01' }]
  })
  const untouched = validateCleanupDebt(expired, { now, markers })
  assert.equal(untouched.ok, true)
  assert.equal(untouched.actionable[0].id, 'CD-001')
  assert.equal(untouched.actionable[0].level, 3)

  const changed = validateCleanupDebt(expired, {
    now,
    markers,
    changedFiles: ['packages/a/src/adapter.ts']
  })
  assert.equal(changed.ok, false)
  assert.match(changed.errors.join('\n'), /expired/)
})

test('duplicate ids, missing fields and invalid dates are rejected', () => {
  const duplicate = validateCleanupDebt(
    registry({ items: [registry().items[0], registry().items[0]] }),
    { now, markers }
  )
  assert.equal(duplicate.ok, false)
  assert.match(duplicate.errors.join('\n'), /duplicate/)

  const missing = registry({
    items: [{ ...registry().items[0], owner: '', expiresAt: 'not-a-date' }]
  })
  const result = validateCleanupDebt(missing, { now, markers })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /owner|expiresAt/)
})

test('markers must identify an existing debt and its declared target', () => {
  const unknown = validateCleanupDebt(registry(), {
    now,
    markers: { 'packages/a/src/adapter.ts': ['CD-999'] }
  })
  assert.equal(unknown.ok, false)
  assert.match(unknown.errors.join('\n'), /unknown marker/)

  const wrongTarget = validateCleanupDebt(registry(), {
    now,
    markers: { 'packages/a/src/other.ts': ['CD-001'] }
  })
  assert.equal(wrongTarget.ok, false)
  assert.match(wrongTarget.errors.join('\n'), /target/)
})

test('debt markers are extracted only around exact marker ids', () => {
  assert.deepEqual(
    extractCleanupDebtMarkers({
      'packages/a/src/adapter.ts':
        '// cleanup-debt: CD-001\nconst x = 1\n// cleanup-debt: CD-002 and CD-003'
    }),
    { 'packages/a/src/adapter.ts': ['CD-001', 'CD-002'] }
  )
})
