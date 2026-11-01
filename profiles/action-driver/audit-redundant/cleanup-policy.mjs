const LEVEL_STATE = {
  1: new Set(['ready', 'verified']),
  2: new Set(['ready', 'verified']),
  3: new Set(['ready', 'verified']),
  4: new Set(['report-only'])
}

const L1_EVIDENCE = new Set(['audit', 'knip', 'compiler', 'lint'])
const L2_EVIDENCE = new Set(['serena', 'ripwire', 'behavior'])

function sources(candidate) {
  return new Set((candidate.evidence || []).map((item) => item.source))
}

function riskReasons(candidate, { publicOrDynamic = false } = {}) {
  const risk = candidate.risk || {}
  const reasons = []
  if (risk.publicContract) reasons.push('public contract requires human approval')
  if (risk.dynamicEntrypoints) reasons.push('dynamic entrypoint requires human approval')
  if (risk.externalConsumers) reasons.push('external consumers require human approval')
  if (publicOrDynamic && reasons.length) return reasons
  return reasons
}

export function actionForCandidate(candidate) {
  const reasons = []
  if (!candidate || typeof candidate !== 'object')
    return { allowed: false, reasons: ['candidate required'] }
  if (![1, 2, 3, 4].includes(candidate.level))
    return { allowed: false, reasons: ['candidate level must be 1-4'] }
  if (!Array.isArray(candidate.targets) || candidate.targets.length === 0)
    reasons.push('candidate targets required')
  if (!Array.isArray(candidate.allowedChanges) || candidate.allowedChanges.length === 0)
    reasons.push('candidate allowedChanges required')
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0)
    reasons.push('current-round evidence required')
  if (!LEVEL_STATE[candidate.level].has(candidate.state))
    reasons.push(`state ${candidate.state || 'missing'} is not valid for L${candidate.level}`)

  const evidence = sources(candidate)
  const elevatedRisk = riskReasons(candidate).length > 0

  if (candidate.level === 1) {
    if (![...L1_EVIDENCE].some((source) => evidence.has(source)))
      reasons.push('L1 requires audit, knip, compiler or lint evidence')
    if (elevatedRisk) reasons.push(...riskReasons(candidate))
  } else if (candidate.level === 2) {
    const missing = [...L2_EVIDENCE].filter((source) => !evidence.has(source))
    if (missing.length) reasons.push(`L2 requires ${missing.join(', ')} evidence`)
    if (elevatedRisk) reasons.push(...riskReasons(candidate))
  } else if (candidate.level === 3) {
    if (candidate.review?.decision !== 'approved')
      reasons.push('L3 requires explicit human approval')
    if (!evidence.has('human-approval')) reasons.push('L3 requires human-approval evidence')
  } else {
    reasons.push('L4 is report-only and cannot execute cleanup')
  }
  return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] }
}

export function buildCleanupLedger({
  runId,
  createdAt,
  snapshot,
  scope = [],
  toolRuns = [],
  debt = [],
  candidates = []
}) {
  if (!runId || !snapshot?.digest) throw new Error('runId and snapshot.digest are required')
  const ids = new Set()
  const normalized = candidates.map((candidate) => {
    if (!candidate.id || ids.has(candidate.id))
      throw new Error(`duplicate candidate id: ${candidate.id}`)
    ids.add(candidate.id)
    return {
      ...candidate,
      snapshot: candidate.snapshot || snapshot.digest,
      evidence: (candidate.evidence || []).map((item) => ({
        ...item,
        snapshot: item.snapshot || snapshot.digest
      }))
    }
  })
  return {
    schemaVersion: 1,
    runId,
    createdAt,
    snapshot: {
      digest: snapshot.digest,
      head: snapshot.head,
      files: snapshot.files || {},
      inputs: snapshot.inputs || {}
    },
    scope,
    toolRuns,
    debt,
    candidates: normalized
  }
}

export function validateCleanupLedger(ledger, { currentSnapshot } = {}) {
  const errors = []
  if (ledger?.schemaVersion !== 1) errors.push('unsupported cleanup ledger schema')
  if (typeof ledger?.runId !== 'string' || !ledger.runId) errors.push('ledger runId required')
  if (typeof ledger?.snapshot?.digest !== 'string' || !ledger.snapshot.digest)
    errors.push('ledger snapshot digest required')
  if (currentSnapshot && currentSnapshot.digest !== ledger?.snapshot?.digest)
    errors.push('stale snapshot: workspace changed since cleanup scan')
  if (!Array.isArray(ledger?.candidates)) errors.push('ledger candidates must be an array')
  else {
    const ids = new Set()
    for (const candidate of ledger.candidates) {
      if (!candidate.id || ids.has(candidate.id)) errors.push('candidate ids must be unique')
      ids.add(candidate.id)
      if (candidate.snapshot !== ledger.snapshot.digest)
        errors.push(`candidate ${candidate.id} has stale snapshot`)
      for (const item of candidate.evidence || [])
        if (item.snapshot !== ledger.snapshot.digest)
          errors.push(`candidate ${candidate.id} has stale ${item.source || 'unknown'} evidence`)
    }
  }
  return { ok: errors.length === 0, errors }
}

export function validateCleanupDiff(candidate, changes = []) {
  const errors = []
  if (!Array.isArray(changes) || changes.length === 0)
    errors.push('no changed files for cleanup candidate')
  const allowed = new Map((candidate.allowedChanges || []).map((item) => [item.file, item]))
  let testChanges = 0
  for (const change of changes) {
    const permission = allowed.get(change.file)
    if (!permission) {
      errors.push(`scope violation: ${change.file} is not allowed by ${candidate.id}`)
      continue
    }
    const additions = Number(change.additions || 0)
    const deletions = Number(change.deletions || 0)
    const maxNetAdditions = Number(permission.maxNetAdditions || 0)
    if (additions - deletions > maxNetAdditions)
      errors.push(
        `unapproved production addition: ${change.file} net +${additions - deletions}, max ${maxNetAdditions}`
      )
    if (permission.kind === 'test') {
      testChanges++
      if (!['rewrite', 'delete-obsolete'].includes(candidate.review?.testDecision))
        errors.push(`testDecision required for changed test ${change.file}`)
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    properties: {
      scope: !errors.some((error) => error.startsWith('scope violation')),
      additions: !errors.some((error) => error.startsWith('unapproved production addition')),
      tests:
        testChanges === 0 || ['rewrite', 'delete-obsolete'].includes(candidate.review?.testDecision)
    }
  }
}
