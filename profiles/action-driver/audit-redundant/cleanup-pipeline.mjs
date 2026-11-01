#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './lib.mjs'
import {
  actionForCandidate,
  buildCleanupLedger as createLedgerRecord,
  validateCleanupDiff,
  validateCleanupLedger
} from './cleanup-policy.mjs'
import { extractCleanupDebtMarkers, validateCleanupDebt } from './cleanup-debt.mjs'
import { executeCommand, snapshotRepo } from '../local-quality/native.mjs'

const RISK_PATH =
  /(?:^|\/)(?:index\.[cm]?[jt]sx?|plugin\.json|worker\.[cm]?[jt]s|.*worker.*\.[cm]?[jt]s|.*\.d\.ts)$/i
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|e2e)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/
const SENSITIVE_PATH =
  /(?:^|\/)(?:shell|credentials?|network|mcp|permissions?|paths?|files?|plugins?)(?:\/|\.)/i
const DEBT_REGISTRY = 'config/quality/cleanup-debt.json'

function assertQualityNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 20 || (major === 20 && minor < 19))
    throw new Error(
      `Knip 6.43.0 requires Node >=20.19; current ${process.version}. Use the repository quality-tool Node (verified 22.23.4).`
    )
}

function executeFor(root) {
  const nodeBin = path.dirname(process.execPath)
  return (command) =>
    executeCommand(command, root, {
      ...process.env,
      PATH: [nodeBin, process.env.PATH].filter(Boolean).join(path.delimiter)
    })
}

function safeReadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function riskFor(file) {
  const dynamic = /(?:worker|plugin|dynamic|reflection|eval|config)/i.test(file)
  const publicContract = RISK_PATH.test(file)
  return {
    publicContract,
    dynamicEntrypoints: dynamic,
    externalConsumers: publicContract
  }
}

function target(file, symbol) {
  return symbol ? { file, symbol } : { file }
}

function candidate(kind, level, targets, evidence, options = {}) {
  const files = [...new Set(targets.map((item) => item.file))]
  const testTarget = files.some((file) => TEST_PATH.test(file))
  return {
    id: '',
    kind,
    level,
    state:
      level === 4
        ? 'report-only'
        : level === 3
          ? 'review-required'
          : level === 2
            ? 'evidence-required'
            : 'ready',
    targets,
    allowedChanges: files.map((file) => ({
      file,
      kind: TEST_PATH.test(file) ? 'test' : 'source',
      maxNetAdditions: TEST_PATH.test(file) ? 20 : 0
    })),
    evidence,
    risk: files.map(riskFor).reduce(
      (risk, next) => ({
        publicContract: risk.publicContract || next.publicContract,
        dynamicEntrypoints: risk.dynamicEntrypoints || next.dynamicEntrypoints,
        externalConsumers: risk.externalConsumers || next.externalConsumers
      }),
      { publicContract: false, dynamicEntrypoints: false, externalConsumers: false }
    ),
    review: {
      decision: 'pending',
      testDecision: testTarget ? 'unchanged' : 'unchanged'
    },
    ...options
  }
}

function addCandidate(list, next) {
  const key = `${next.kind}:${next.targets
    .map((item) => `${item.file}#${item.symbol || ''}`)
    .sort()
    .join(',')}:${next.identity || ''}`
  if (list.some((item) => item._key === key)) return
  list.push({ ...next, _key: key })
}

function knipCandidateKind(category) {
  if (category === 'exports' || category === 'types') return 'knip-unused-export'
  if (category === 'dependencies' || category === 'devDependencies') return 'knip-unused-dependency'
  if (category === 'binaries') return 'knip-missing-binary'
  if (category === 'unlisted') return 'knip-unlisted-dependency'
  if (category === 'duplicates') return 'knip-duplicate-export'
  return `knip-${category || 'issue'}`
}

export function buildCleanupLedger({
  runId,
  createdAt,
  snapshot,
  scope,
  toolRuns,
  debt = [],
  reports = {}
}) {
  const candidates = []
  const auditEvidence = { source: 'audit', detail: 'current all/deep scan' }
  for (const file of reports.audit?.provenUnreachable || [])
    addCandidate(candidates, candidate('unreachable-file', 1, [target(file)], [auditEvidence]))
  for (const row of reports.audit?.likelyUnused || [])
    addCandidate(
      candidates,
      candidate(
        'likely-unused-file',
        2,
        [target(typeof row === 'string' ? row : row.file)],
        [auditEvidence]
      )
    )
  for (const row of reports.symbols?.deadValueExports || [])
    addCandidate(
      candidates,
      candidate(
        'dead-export',
        3,
        [target(row.file, row.name)],
        [{ source: 'audit', detail: `symbol dead-code:${row.name}` }]
      )
    )
  for (const file of reports.knip?.files || [])
    addCandidate(
      candidates,
      candidate(
        'knip-unused-file',
        1,
        [target(file)],
        [{ source: 'knip', detail: 'unused file from current quality run' }]
      )
    )
  for (const issue of reports.knip?.issues || []) {
    if (!issue?.file) continue
    addCandidate(
      candidates,
      candidate(
        issue.kind || knipCandidateKind(issue.category),
        2,
        [target(issue.file, issue.value)],
        [
          {
            source: 'knip',
            detail: JSON.stringify({
              category: issue.category,
              value: issue.value,
              finding: issue.finding
            })
          }
        ],
        { identity: `${issue.category || 'unknown'}:${issue.value || ''}` }
      )
    )
  }
  for (const item of [
    ...(reports.deadTests?.brokenImports || []),
    ...(reports.deadTests?.unreferencedFixtures || []).map((file) => ({ file }))
  ]) {
    if (!item?.file) continue
    addCandidate(
      candidates,
      candidate(
        'stale-test',
        2,
        [target(item.file)],
        [
          {
            source: 'audit',
            detail: item.spec ? `broken import ${item.spec}` : 'unreferenced fixture'
          }
        ],
        {
          identity: item.spec || item.file,
          review: { decision: 'pending', testDecision: 'delete-obsolete' }
        }
      )
    )
  }
  for (const duplicate of reports.jscpd?.duplicates || []) {
    const files = [duplicate.firstFile?.name, duplicate.secondFile?.name].filter(Boolean)
    if (!files.length) continue
    addCandidate(
      candidates,
      candidate(
        'duplicate-code',
        2,
        [...new Set(files)].map((file) => target(file)),
        [{ source: 'jscpd', detail: duplicate.format || 'clone candidate' }]
      )
    )
  }
  for (const item of debt) {
    addCandidate(
      candidates,
      candidate(
        'cleanup-debt',
        3,
        item.targets || [],
        [{ source: 'debt', detail: `expired cleanup debt ${item.id}` }],
        { debtId: item.id }
      )
    )
  }

  const ordered = candidates.map((item, index) => {
    const { _key, ...rest } = item
    return { ...rest, id: `C-${String(index + 1).padStart(3, '0')}` }
  })
  return createLedgerRecord({
    runId,
    createdAt,
    snapshot,
    scope,
    toolRuns,
    debt,
    candidates: ordered
  })
}

export function normalizeJscpdDuplicates(duplicates, resolveFile) {
  const resolved = []
  const unresolved = []
  for (const duplicate of duplicates || []) {
    const first = duplicate.firstFile?.name ? resolveFile(duplicate.firstFile.name) : null
    const second = duplicate.secondFile?.name ? resolveFile(duplicate.secondFile.name) : null
    if (!first || !second) {
      unresolved.push({
        format: duplicate.format,
        firstFile: duplicate.firstFile?.name,
        secondFile: duplicate.secondFile?.name
      })
      continue
    }
    resolved.push({
      ...duplicate,
      firstFile: { ...duplicate.firstFile, name: first },
      secondFile: { ...duplicate.secondFile, name: second }
    })
  }
  return { duplicates: resolved, unresolved }
}

export function assessCleanupVerification({
  change,
  checks = [],
  counterexample = null,
  evidenceGaps = []
}) {
  const errors = []
  if (!change?.ok) errors.push(...(change?.errors || ['cleanup diff failed']))
  for (const check of checks) {
    const passed =
      check.status === 'success' ||
      (check.execution === 'success' && ['pass', 'review'].includes(check.verdict))
    if (!passed) errors.push(`${check.id || 'check'} did not pass`)
  }
  if (counterexample) errors.push(`differential counterexample found: ${counterexample}`)
  if (evidenceGaps.length) errors.push(...evidenceGaps.map((gap) => `${gap.source}: ${gap.detail}`))
  return { ok: errors.length === 0, errors }
}

export function extractCounterexample(text) {
  const source = String(text || '')
  if (!/Counterexample:/i.test(source)) return null
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /Counterexample:/i.test(line))
  return lines
    .slice(start, start + 8)
    .filter((line) => /Counterexample:|seed:|path:|Shrunk/i.test(line))
    .join('\n')
}

export function buildEvidenceGap(source, detail) {
  return { source, status: 'missing', detail }
}

export function buildDeletionDecision(item) {
  const review = item?.review || {}
  const risk = item?.risk || {}
  if (
    item?.level !== 1 ||
    item.targets?.length !== 1 ||
    !item.targets[0]?.file ||
    item.targets[0]?.symbol ||
    !Array.isArray(item.evidence) ||
    item.evidence.length === 0 ||
    risk.publicContract ||
    risk.dynamicEntrypoints ||
    risk.externalConsumers ||
    review.deletionReviewed !== true ||
    review.publicContractReviewed !== true ||
    review.dynamicEntrypointsReviewed !== true ||
    review.consumersReviewed !== true
  )
    return null
  return {
    file: item.targets[0].file,
    reason: `cleanup candidate ${item.id} reviewed as a retired file`,
    checks: {
      publicContract: true,
      dynamicEntrypoints: true,
      consumers: true
    }
  }
}

export function changedFilesFromSnapshots(before, after) {
  const keys = new Set([...Object.keys(before?.inputs || {}), ...Object.keys(after?.inputs || {})])
  return [...keys].filter((file) => before?.inputs?.[file] !== after?.inputs?.[file]).sort()
}

export function readDiffStats(root, files) {
  if (!files.length) return []
  const run = executeCommand(
    ['git', 'diff', '--numstat', '--no-renames', 'HEAD', '--', ...files],
    root
  )
  if (run.code !== 0) throw new Error(run.stderr || run.error || 'git diff failed')
  const rows = new Map()
  for (const line of run.stdout.trim().split(/\r?\n/)) {
    if (!line) continue
    const [addRaw, deleteRaw, ...pathParts] = line.split('\t')
    const file = pathParts.join('\t')
    if (!file) continue
    rows.set(file, {
      file,
      additions: addRaw === '-' ? 0 : Number(addRaw),
      deletions: deleteRaw === '-' ? 0 : Number(deleteRaw)
    })
  }
  for (const file of files) {
    if (rows.has(file)) continue
    const absolute = path.join(root, file)
    const additions = fs.existsSync(absolute)
      ? fs.readFileSync(absolute, 'utf8').split(/\r?\n/).length
      : 0
    rows.set(file, { file, additions, deletions: 0 })
  }
  return [...rows.values()]
}

function parseTool(run, id, artifact) {
  return {
    id,
    status: run.code === 0 ? 'success' : run.code === 1 ? 'findings' : 'error',
    exitCode: run.code,
    artifact,
    detail: run.error || run.stderr || run.stdout
  }
}

function readQualityOutcome(root, runDir) {
  const results = safeReadJson(path.join(runDir, 'results.json'), null)
  if (!results) return { files: [], issues: [], duplicates: [], results: null }
  const knip = results.results?.filter((item) => item.id.startsWith('knip')) || []
  const files = knip.flatMap((item) =>
    (item.findings || [])
      .filter((finding) => finding.startsWith('unused-file:'))
      .map((finding) => finding.slice('unused-file:'.length))
  )
  const jscpdItem = results.results?.find((item) => item.id === 'jscpd')
  const reportPath = jscpdItem?.report
  const report = reportPath ? safeReadJson(path.resolve(root, reportPath), null) : null
  const normalized = normalizeJscpdDuplicates(report?.duplicates || [], (file) =>
    resolveWorkspaceFile(root, file)
  )
  return {
    results,
    files: [...new Set(files)],
    issues: knip.flatMap((item) =>
      (item.findings || [])
        .filter((finding) => !finding.startsWith('unused-file:'))
        .map((finding) => {
          const [file, category, ...valueParts] = finding.split(':')
          return {
            file,
            category,
            value: valueParts.join(':'),
            finding
          }
        })
    ),
    duplicates: normalized.duplicates,
    unresolvedDuplicates: normalized.unresolved
  }
}

function readDebt(root, changedFiles = []) {
  const registry = safeReadJson(path.join(root, DEBT_REGISTRY), {
    schemaVersion: 1,
    items: []
  })
  const contents = {}
  for (const item of registry.items || [])
    for (const target of item.targets || []) {
      const absolute = path.join(root, target.file)
      if (fs.existsSync(absolute)) contents[target.file] = fs.readFileSync(absolute, 'utf8')
    }
  const markers = extractCleanupDebtMarkers(contents)
  return {
    registry,
    ...validateCleanupDebt(registry, { markers, changedFiles })
  }
}

function resolveWorkspaceFile(root, file) {
  const clean = file.replace(/^\.\//, '')
  if (fs.existsSync(path.join(root, clean))) return clean
  const matches = ['apps', 'packages', 'plugins', 'scripts', 'tests']
    .map((prefix) => `${prefix}/${clean}`)
    .filter((candidate) => fs.existsSync(path.join(root, candidate)))
  return matches.length === 1 ? matches[0] : null
}

function runStructuralTools(root, candidate, outDir, changedFiles = [], runTool = executeCommand) {
  const evidenceGaps = []
  const runs = []
  const files = candidate.targets.map((item) => item.file)
  if (candidate.tools?.astGrep) {
    const artifact = path.join(outDir, 'ast-grep.json')
    const run = runTool(
      ['ast-grep', 'scan', '--config', candidate.tools.astGrep, '--json=compact', ...files],
      root
    )
    if (run.error?.includes('ENOENT')) entryGap(evidenceGaps, 'ast-grep', run.error)
    else {
      fs.writeFileSync(artifact, run.stdout)
      runs.push(parseTool(run, 'ast-grep', artifact))
    }
  }
  if (candidate.tools?.semgrepRules) {
    const artifact = path.join(outDir, 'semgrep.json')
    const run = runTool(
      [
        'semgrep',
        'scan',
        '--metrics=off',
        '--config',
        candidate.tools.semgrepRules,
        '--autofix',
        '--dryrun',
        '--json',
        ...files
      ],
      root
    )
    if (run.error?.includes('ENOENT')) entryGap(evidenceGaps, 'semgrep', run.error)
    else {
      fs.writeFileSync(artifact, run.stdout)
      runs.push(parseTool(run, 'semgrep', artifact))
    }
  }
  const sensitive = changedFiles.filter((file) => SENSITIVE_PATH.test(file))
  if (sensitive.length) {
    const artifact = path.join(outDir, 'semgrep-sensitive.json')
    const run = runTool(
      ['semgrep', 'scan', '--metrics=off', '--config', 'p/default', '--json', ...sensitive],
      root
    )
    if (run.error?.includes('ENOENT')) entryGap(evidenceGaps, 'semgrep', run.error)
    else {
      fs.writeFileSync(artifact, run.stdout)
      runs.push(parseTool(run, 'semgrep-sensitive', artifact))
    }
  }
  return { runs, evidenceGaps }
}

function entryGap(gaps, source, detail) {
  gaps.push(buildEvidenceGap(source, detail))
}

function ratchetCommand(runDir) {
  return [
    process.execPath,
    'scripts/local-quality/run.mjs',
    '--mode',
    'full',
    '--only',
    'knip,knip-production,jscpd',
    '--out',
    runDir
  ]
}

function packageForFile(root, file) {
  let directory = path.dirname(path.join(root, file))
  while (directory.startsWith(root)) {
    const manifest = path.join(directory, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
        if (typeof pkg.name === 'string' && pkg.name !== 'action-driver') return pkg.name
      } catch {}
      return null
    }
    if (directory === root) break
    directory = path.dirname(directory)
  }
  return null
}

function runTargetedChecks(root, item, tests, outDir, execute) {
  const changed = item.targets
    .map((target) => target.file)
    .filter((file) => fs.existsSync(path.join(root, file)))
  const commands = []
  if (changed.length)
    commands.push({
      id: 'eslint-targets',
      command: ['pnpm', 'exec', 'eslint', ...changed, '--format', 'json']
    })
  const packages = [
    ...new Set(item.targets.map((target) => packageForFile(root, target.file)).filter(Boolean))
  ]
  for (const name of packages)
    commands.push({ id: `typecheck:${name}`, command: ['pnpm', '--filter', name, 'typecheck'] })
  if (tests.length)
    commands.push({ id: 'related-tests', command: ['pnpm', 'exec', 'vitest', 'run', ...tests] })
  return commands.map(({ id, command }) => {
    const artifact = path.join(outDir, `${id.replaceAll(/[^a-z0-9_-]+/gi, '-')}.log`)
    const run = execute(command)
    fs.writeFileSync(artifact, `${run.stdout || ''}\n${run.stderr || ''}\n${run.error || ''}`)
    return parseTool(run, id, artifact)
  })
}

export async function prepareCleanup({ root = ROOT, out, now = new Date(), ports = {} }) {
  if (!out) throw new Error('prepare requires --out artifacts/test-reports/redundant-code/<run>')
  if (!ports.execute) assertQualityNode()
  const snapshot = ports.snapshot || (() => snapshotRepo(root))
  const execute = ports.execute || executeFor(root)
  const before = snapshot()
  if (fs.existsSync(path.resolve(root, out)))
    throw new Error('cleanup run directory already exists; choose a new run')

  const toolRuns = []
  for (const command of [
    [process.execPath, 'scripts/audit-redundant/run-all.mjs', '--out', out],
    [process.execPath, 'scripts/audit-redundant/run-deep.mjs', '--out', out]
  ]) {
    const run = execute(command)
    toolRuns.push(parseTool(run, command[1].split('/').at(-1).replace('.mjs', ''), out))
    if (run.code !== 0) break
  }

  const qualityDir = `${out}/baseline-quality`
  const qualityRun = execute([
    process.execPath,
    'scripts/local-quality/run.mjs',
    '--mode',
    'full',
    '--only',
    'knip,knip-production,jscpd',
    '--out',
    qualityDir
  ])
  toolRuns.push(parseTool(qualityRun, 'baseline-quality', qualityDir))

  const after = snapshot()
  if (after.digest !== before.digest)
    throw new Error('workspace changed during cleanup prepare; evidence is stale')
  const scan = safeReadJson(path.join(root, out, 'scan.json'), null)
  if (!scan?.stages?.includes('all') || !scan.stages.includes('deep'))
    throw new Error('completed all + deep audit evidence is required')
  if (scan.snapshot?.digest !== before.digest)
    throw new Error('audit snapshot does not match current workspace')

  const quality = readQualityOutcome(root, path.join(root, qualityDir))
  if (quality.unresolvedDuplicates.length)
    toolRuns.push({
      id: 'cleanup-jscpd-paths',
      status: 'error',
      exitCode: 1,
      artifact: `${qualityDir}/jscpd/jscpd-report.json`,
      detail: `${quality.unresolvedDuplicates.length} duplicate blocks could not be mapped to a unique workspace path`
    })
  const reports = {
    audit: safeReadJson(path.join(root, out, 'false-positive-refined.json'), {}),
    symbols: safeReadJson(path.join(root, out, 'symbol-dead-code.json'), {}),
    deadTests: safeReadJson(path.join(root, out, 'dead-tests.json'), {}),
    knip: { files: quality.files, issues: quality.issues },
    jscpd: { duplicates: quality.duplicates },
    results: quality.results
  }
  const debt = readDebt(root)
  if (!debt.ok)
    toolRuns.push({
      id: 'cleanup-debt',
      status: 'error',
      exitCode: 1,
      artifact: DEBT_REGISTRY,
      detail: debt.errors.join('; ')
    })
  const ledger = buildCleanupLedger({
    runId: path.basename(out),
    createdAt: now.toISOString(),
    snapshot: before,
    scope: ['apps', 'packages', 'plugins', 'scripts'],
    toolRuns,
    debt: debt.actionable || [],
    reports
  })
  const ledgerPath = path.join(root, out, 'cleanup-ledger.json')
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
  fs.writeFileSync(
    path.join(root, out, 'SUMMARY.md'),
    renderCleanupSummary(ledger, { debt, quality: reports.results })
  )
  return {
    ledger,
    ledgerPath,
    exitCode: toolRuns.every((run) => run.status !== 'error') ? 0 : 2
  }
}

export async function verifyCleanup({
  root = ROOT,
  run,
  candidateId,
  tests = [],
  now = new Date(),
  ports = {}
}) {
  if (!run || !candidateId) throw new Error('verify requires --run and --candidate')
  if (!ports.execute) assertQualityNode()
  const snapshot = ports.snapshot || (() => snapshotRepo(root))
  const execute = ports.execute || executeFor(root)
  const ledgerPath = path.join(root, run, 'cleanup-ledger.json')
  const ledger = safeReadJson(ledgerPath, null)
  if (!ledger) throw new Error('cleanup-ledger.json not found')
  const schema = validateCleanupLedger(ledger)
  if (!schema.ok) throw new Error(schema.errors.join('; '))
  const item = ledger.candidates.find((row) => row.id === candidateId)
  if (!item) throw new Error(`unknown candidate: ${candidateId}`)
  const action = actionForCandidate(item)
  if (!action.allowed) throw new Error(`candidate is not executable: ${action.reasons.join('; ')}`)

  const current = snapshot()
  const files = changedFilesFromSnapshots(ledger.snapshot, current)
  const stats = (ports.diffStats || ((rows) => readDiffStats(root, rows)))(files)
  const change = validateCleanupDiff(item, stats)
  const debt = readDebt(root, files)
  const verifyDir = path.join(root, run, `verify-${candidateId}`)
  if (fs.existsSync(verifyDir)) throw new Error(`verification already exists: ${verifyDir}`)
  fs.mkdirSync(verifyDir, { recursive: true })

  const tools = runStructuralTools(root, item, verifyDir, files, execute)
  const selectedTests = tests.length ? tests : item.tests || []
  for(const test of selectedTests){
    if(typeof test!=='string'||test.startsWith('-')||path.isAbsolute(test)||test.split(/[\\/]/).includes('..')) throw new Error('Invalid test path')
    const abs=path.resolve(root,test)
    if(fs.realpathSync(abs)!==abs||!fs.statSync(abs).isFile())throw new Error('Expected a regular project test file')
  }
  const targeted = runTargetedChecks(
    root,
    item,
    selectedTests,
    verifyDir,
    execute
  )
  const counterexample = extractCounterexample(
    targeted
      .map((check) => {
        const artifact = path.resolve(root, check.artifact)
        return fs.existsSync(artifact) ? fs.readFileSync(artifact, 'utf8') : ''
      })
      .join('\n')
  )
  const ratchetDir = path.join(verifyDir, 'ratchet')
  const ratchetRun = execute(ratchetCommand(path.relative(root, ratchetDir)))
  const ratchet = readQualityOutcome(root, ratchetDir)

  const checks = [...targeted, ...tools.runs]
  const evidenceGaps = [...tools.evidenceGaps]
  if (targeted.length === 0)
    evidenceGaps.push(buildEvidenceGap('targeted-checks', 'no target or test checks selected'))
  if (!ratchet.results) evidenceGaps.push(buildEvidenceGap('ratchet', 'missing results.json'))
  if (!debt.ok)
    evidenceGaps.push(...debt.errors.map((detail) => buildEvidenceGap('cleanup-debt', detail)))
  const baseline = safeReadJson(path.join(root, run, 'baseline-quality/results.json'), null)
  const baselineQuality = baseline
    ? {
        files: (baseline.results || [])
          .filter((item) => item.id?.startsWith('knip'))
          .flatMap((item) =>
            (item.findings || [])
              .filter((finding) => finding.startsWith('unused-file:'))
              .map((finding) => finding.slice('unused-file:'.length))
          ),
        duplicates: (baseline.results || []).find((item) => item.id === 'jscpd')?.findings || []
      }
    : { files: [], duplicates: [] }
  const newUnusedFiles = ratchet.files.filter((file) => !baselineQuality.files.includes(file))
  const baselineDuplicates = new Set(baselineQuality.duplicates)
  const newDuplicates = ratchet.duplicates
    .map((duplicate) => JSON.stringify(duplicate))
    .filter((duplicate) => !baselineDuplicates.has(duplicate))
  if (newUnusedFiles.length)
    evidenceGaps.push(
      buildEvidenceGap('knip-ratchet', `new unused files: ${newUnusedFiles.join(', ')}`)
    )
  if (newDuplicates.length)
    evidenceGaps.push(
      buildEvidenceGap('jscpd-ratchet', `new duplicate clones: ${newDuplicates.length}`)
    )
  checks.push({
    id: 'ratchet',
    status:
      !ratchet.results || ratchetRun.code > 1 || newUnusedFiles.length || newDuplicates.length
        ? 'error'
        : 'success',
    exitCode: ratchetRun.code,
    artifact: path.relative(root, ratchetDir),
    detail: 'compared with this run baseline'
  })
  const assessment = assessCleanupVerification({
    change,
    checks,
    counterexample,
    evidenceGaps
  })
  const result = {
    schemaVersion: 1,
    candidateId,
    verifiedAt: now.toISOString(),
    snapshot: current,
    changedFiles: stats,
    debtActionable: debt.actionable,
    checks,
    counterexample,
    evidenceGaps,
    postRatchet: {
      newFiles: newUnusedFiles,
      newDuplicates,
      duplicateCount: ratchet.duplicates.length
    },
    ...assessment
  }
  fs.writeFileSync(
    path.join(verifyDir, 'verification.json'),
    JSON.stringify(result, null, 2) + '\n'
  )
  item.state = assessment.ok ? 'verified' : item.state
  item.verification = {
    ok: assessment.ok,
    path: path.relative(root, path.join(verifyDir, 'verification.json')),
    errors: assessment.errors
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
  return { ...result, exitCode: assessment.ok ? 0 : 1 }
}

export function renderCleanupSummary(ledger, { debt, quality } = {}) {
  const counts = ledger.candidates.reduce((acc, item) => {
    acc[`L${item.level}`] = (acc[`L${item.level}`] || 0) + 1
    return acc
  }, {})
  return `# Coding-agent cleanup plan

Run: ${ledger.runId}
Snapshot: ${ledger.snapshot.digest}
Candidates: ${ledger.candidates.length}
Levels: ${JSON.stringify(counts)}
Debt actionable: ${debt?.actionable?.length || 0}
Quality evidence: ${quality ? 'available' : 'missing'}

Candidates are not deletion approvals. Read cleanup-ledger.json and satisfy the evidence required by each level.
`
}

function parseCliArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help') return { help: true }
  const [command, ...rest] = argv
  const options = { command }
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (arg === '--') continue
    else if (arg === '--help') options.help = true
    else if (['--out', '--run', '--candidate', '--tests'].includes(arg)) {
      const value = rest[++index]
      if (!value || value.startsWith('--')) throw new Error(`missing value: ${arg}`)
      if (arg === '--tests') options.tests = value.split(',')
      else options[arg.slice(2)] = value
    } else if (arg === '--apply') options.apply = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

export async function deleteFile({ root, run, candidate, apply = false, execute }) {
  const ledger = safeReadJson(path.join(root, run, 'cleanup-ledger.json'), null)
  if (!ledger) throw new Error('cleanup-ledger.json not found')
  const schema = validateCleanupLedger(ledger)
  if (!schema.ok) throw new Error(schema.errors.join('; '))
  const item = ledger.candidates.find((row) => row.id === candidate)
  const action = actionForCandidate(item)
  if (!action.allowed) throw new Error(`candidate is not executable: ${action.reasons.join('; ')}`)
  const decision = buildDeletionDecision(item)
  if (!decision) throw new Error('candidate is not fully reviewed for whole-file deletion')
  const targetDir = path.join(root, run, `delete-${candidate}`)
  if (fs.existsSync(targetDir)) throw new Error(`deletion review already exists: ${targetDir}`)
  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(path.join(root, run, 'scan.json'), path.join(targetDir, 'scan.json'))
  const decisions = path.join(targetDir, 'decisions.json')
  fs.writeFileSync(decisions, JSON.stringify([decision], null, 2) + '\n')
  const runCommand = execute || executeFor(root)
  const prepared = runCommand(
    [
      process.execPath,
      'scripts/audit-redundant/prepare-review.mjs',
      '--run',
      path.relative(root, targetDir),
      '--decisions',
      path.relative(root, decisions)
    ],
    root
  )
  if (prepared.code !== 0)
    throw new Error(prepared.stderr || prepared.error || 'review preparation failed')
  const manifest = path.join(targetDir, 'reviewed.json')
  const removal = runCommand(
    [
      process.execPath,
      'scripts/audit-redundant/13-remove-proven.mjs',
      `--from=${path.relative(root, manifest)}`,
      apply ? '--apply' : '--dry-run'
    ],
    root
  )
  if (removal.code !== 0) throw new Error(removal.stderr || removal.error || 'deletion failed')
  return JSON.parse(removal.stdout)
}

export async function main(argv = process.argv.slice(2), root = ROOT) {
  const options = parseCliArgs(argv)
  if (options.help || !options.command) {
    console.log(
      'Usage:\n  node scripts/audit-redundant/cleanup-pipeline.mjs prepare --out artifacts/test-reports/redundant-code/<run>\n  node scripts/audit-redundant/cleanup-pipeline.mjs verify --run <run> --candidate <id> [--tests path,path]\n  node scripts/audit-redundant/cleanup-pipeline.mjs delete-file --run <run> --candidate <id> [--apply]\n  node scripts/audit-redundant/cleanup-pipeline.mjs check-debt\nPrepare runs existing audit all/deep and Knip/jscpd quality checks. Verify never edits source. delete-file defaults to dry-run.'
    )
    return 0
  }
  if (options.command === 'prepare') {
    const result = await prepareCleanup({ root, out: options.out })
    console.log(result.ledgerPath)
    return result.exitCode
  }
  if (options.command === 'verify') {
    const result = await verifyCleanup({
      root,
      run: options.run,
      candidateId: options.candidate,
      tests: options.tests || []
    })
    console.log(JSON.stringify(result, null, 2))
    return result.exitCode
  }
  if (options.command === 'delete-file') {
    const result = await deleteFile({
      root,
      run: options.run,
      candidate: options.candidate,
      apply: options.apply
    })
    console.log(JSON.stringify(result, null, 2))
    return 0
  }
  if (options.command === 'check-debt') {
    const result = readDebt(root)
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  }
  throw new Error(`unknown command: ${options.command}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 2
    })
}
