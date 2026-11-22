import fs from 'node:fs'
import path from 'node:path'
import type { FactSnapshot, KnipMode, KnipRun } from '@architecture-kit/core-ir'
import { snapshotSourceReader, uniqueCloneBlock } from './clone-evidence.js'
import { extractCleanupDebtMarkers, validateCleanupDebt, type ActionableDebt, type DebtRegistry } from './debt.js'
import {
  actionForCandidate,
  buildCleanupLedger as createLedgerRecord,
  validateCleanupDiff,
  validateCleanupLedger,
  type AuditEvidenceItem,
  type CleanupLedger,
  type DiffChange,
  type LedgerCandidate
} from './policy.js'
import { applyRemoval, validateRemoval, type RemovalManifest, type ScanRecord } from './removal.js'
import {
  assertArtifactDir,
  executeCommand,
  snapshotRepo,
  type CommandResolutionOptions,
  type CommandResult,
  type RepoSnapshot
} from './snapshot.js'
import { runAuditStage } from './stages/runner.js'
import { runLocalQuality } from '../quality/run.js'

const RISK_PATH =
  /(?:^|\/)(?:index\.[cm]?[jt]sx?|plugin\.json|worker\.[cm]?[jt]s|.*worker.*\.[cm]?[jt]s|.*\.d\.ts)$/i
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|e2e)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/
const SENSITIVE_PATH =
  /(?:^|\/)(?:shell|credentials?|network|mcp|permissions?|paths?|files?|plugins?)(?:\/|\.)/i
const DEBT_REGISTRY = 'config/quality/cleanup-debt.json'

function assertQualityNode() {
  const parts = process.versions.node.split('.').map(Number)
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  if (major < 20 || (major === 20 && minor < 19)) {
    throw new Error(
      `Knip 6.43.0 requires Node >=20.19; current ${process.version}. Use the repository quality-tool Node (verified 22.23.4).`
    )
  }
}

function executeFor(root: string, options: CommandResolutionOptions = {}) {
  const nodeBin = path.dirname(process.execPath)
  return (command: string[], cwd = root): CommandResult =>
    executeCommand(
      command,
      cwd,
      {
        ...process.env,
        PATH: [nodeBin, process.env.PATH].filter(Boolean).join(path.delimiter)
      },
      options
    )
}

function safeReadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function riskFor(file: string) {
  const dynamic = /(?:worker|plugin|dynamic|reflection|eval|config)/i.test(file)
  const publicContract = RISK_PATH.test(file)
  return {
    publicContract,
    dynamicEntrypoints: dynamic,
    externalConsumers: publicContract
  }
}

function target(file: string, symbol?: string): { file: string; symbol?: string } {
  return symbol ? { file, symbol } : { file }
}

type InternalCandidate = LedgerCandidate & { _key?: string; identity?: string }

function candidate(
  kind: string,
  level: number,
  targets: Array<{ file: string; symbol?: string | undefined }>,
  evidence: AuditEvidenceItem[],
  options: Partial<InternalCandidate> = {}
): InternalCandidate {
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
      kind: TEST_PATH.test(file) ? ('test' as const) : ('source' as const),
      maxNetAdditions: TEST_PATH.test(file) ? 20 : 0
    })),
    evidence,
    risk: files.map(riskFor).reduce(
      (risk, next) => ({
        publicContract: Boolean(risk.publicContract || next.publicContract),
        dynamicEntrypoints: Boolean(risk.dynamicEntrypoints || next.dynamicEntrypoints),
        externalConsumers: Boolean(risk.externalConsumers || next.externalConsumers)
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

function addCandidate(list: InternalCandidate[], next: InternalCandidate) {
  const key = `${next.kind}:${next.targets
    .map((item) => `${item.file}#${item.symbol || ''}`)
    .sort()
    .join(',')}:${next.identity || ''}`
  const existing = list.find((item) => item._key === key)
  if (existing) {
    if (next.kind === 'knip-unused-export') {
      for (const evidence of next.evidence) {
        if (evidence.mode && !existing.evidence.some((item) => item.mode === evidence.mode)) {
          existing.evidence.push(evidence)
        }
      }
    }
    return
  }
  list.push({ ...next, _key: key })
}

function knipCandidateKind(category?: string): string {
  if (category === 'exports' || category === 'types') return 'knip-unused-export'
  if (category === 'dependencies' || category === 'devDependencies') return 'knip-unused-dependency'
  if (category === 'binaries') return 'knip-missing-binary'
  if (category === 'unlisted') return 'knip-unlisted-dependency'
  if (category === 'duplicates') return 'knip-duplicate-export'
  return `knip-${category || 'issue'}`
}

export interface BuildLedgerReports {
  audit?: {
    provenUnreachable?: string[]
    likelyUnused?: Array<string | { file: string }>
  }
  symbols?: {
    deadValueExports?: Array<{ file: string; name: string }>
  }
  knip?: {
    files?: string[]
    productionOnlyFiles?: string[]
    issues?: Array<{
      file?: string | undefined
      kind?: string | undefined
      category?: string | undefined
      mode?: string | undefined
      value?: string | undefined
      finding?: string | undefined
    }>
  }
  deadTests?: {
    brokenImports?: Array<{ file?: string; spec?: string }>
    unreferencedFixtures?: string[]
  }
  jscpd?: {
    duplicates?: Array<{
      format?: string
      firstFile?: { name?: string }
      secondFile?: { name?: string }
    }>
  }
  results?: unknown
}

export function buildCleanupLedger({
  runId,
  createdAt,
  snapshot,
  scope = [],
  toolRuns = [],
  debt = [],
  reports = {}
}: {
  runId: string
  createdAt: string
  snapshot: {
    digest?: string
    head?: string
    files?: Record<string, string>
    inputs?: Record<string, string>
  }
  scope?: string[]
  toolRuns?: unknown[]
  debt?: Array<{ id: string; targets?: Array<{ file: string; symbol?: string | undefined }> | undefined }>
  reports?: BuildLedgerReports
}): CleanupLedger {
  const candidates: InternalCandidate[] = []
  const auditEvidence: AuditEvidenceItem = { source: 'audit', detail: 'current all/deep scan' }
  for (const file of reports.audit?.provenUnreachable || []) {
    addCandidate(candidates, candidate('unreachable-file', 1, [target(file)], [auditEvidence]))
  }
  for (const row of reports.audit?.likelyUnused || []) {
    addCandidate(
      candidates,
      candidate(
        'likely-unused-file',
        2,
        [target(typeof row === 'string' ? row : row.file)],
        [auditEvidence]
      )
    )
  }
  for (const row of reports.symbols?.deadValueExports || []) {
    addCandidate(
      candidates,
      candidate(
        'dead-export',
        3,
        [target(row.file, row.name)],
        [{ source: 'audit', detail: `symbol dead-code:${row.name}` }]
      )
    )
  }
  for (const file of reports.knip?.files || []) {
    addCandidate(
      candidates,
      candidate(
        'knip-unused-file',
        1,
        [target(file)],
        [{ source: 'knip', mode: 'default', detail: 'unused file in default Knip run' }]
      )
    )
  }
  for (const file of reports.knip?.productionOnlyFiles || []) {
    addCandidate(
      candidates,
      candidate(
        'knip-production-unused-file',
        2,
        [target(file)],
        [{ source: 'knip', mode: 'production', detail: 'unused only in production mode' }]
      )
    )
  }
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
            ...(['exports', 'types'].includes(issue.category ?? '') && issue.mode
              ? { mode: issue.mode }
              : {}),
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
    ...(reports.deadTests?.unreferencedFixtures || []).map((file) => ({
      file,
      spec: undefined as string | undefined
    }))
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
    const files = [duplicate.firstFile?.name, duplicate.secondFile?.name].filter(
      (f): f is string => Boolean(f)
    )
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

  const ordered: LedgerCandidate[] = candidates.map((item, index) => {
    const { _key: _ignoredKey, identity: _ignoredIdentity, ...rest } = item
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

export interface JscpdDuplicateEntry {
  format?: string
  fragment?: string
  firstFile?: {
    name?: string
    start?: number
    end?: number
    startLoc?: { position?: number; column?: number }
    endLoc?: { position?: number; column?: number }
  }
  secondFile?: {
    name?: string
    start?: number
    end?: number
    startLoc?: { position?: number; column?: number }
    endLoc?: { position?: number; column?: number }
  }
  [key: string]: unknown
}

export function normalizeJscpdDuplicates(
  duplicates: JscpdDuplicateEntry[] | undefined,
  resolveFile: (file: string) => string | null
) {
  const resolved: Array<
    JscpdDuplicateEntry & { firstFile: { name: string }; secondFile: { name: string } }
  > = []
  const unresolved: Array<{
    format?: string | undefined
    firstFile?: string | undefined
    secondFile?: string | undefined
  }> = []
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

interface CloneOccurrenceKey {
  group: string
  start: number
  finish: number
  file: string
  hash: string
  format: string
  fragment: string
  firstLine: number
  lastLine: number
  startColumn: number
  endColumn: number
}

// jscpd may choose a different representative for an existing occurrence.
export function newDuplicateRecords(
  baseline: string[],
  current: string[],
  beforeInputs: Record<string, string> = {},
  afterInputs: Record<string, string> = {},
  readSource?: (file: string, digest: string) => string | undefined
): string[] {
  const exact = new Set(baseline)
  const priorPairs = new Map<string, [CloneOccurrenceKey, CloneOccurrenceKey][]>()
  const priorOccurrences = new Map<string, CloneOccurrenceKey[]>()

  function occurrences(record: string, inputs: Record<string, string>): CloneOccurrenceKey[] {
    let clone: JscpdDuplicateEntry
    try {
      clone = JSON.parse(record) as JscpdDuplicateEntry
    } catch {
      return []
    }
    if (
      typeof clone?.format !== 'string' ||
      typeof clone.fragment !== 'string' ||
      !clone.fragment
    ) {
      return []
    }
    const keys: CloneOccurrenceKey[] = []
    for (const end of [clone.firstFile, clone.secondFile]) {
      if (typeof end?.name !== 'string') continue
      const name = end.name.replace(/^\.\//, '')
      const matches = ['', 'apps/', 'packages/', 'plugins/', 'scripts/', 'tests/']
        .map((prefix) => prefix + name)
        .filter((file) => Object.hasOwn(inputs, file))
      if (matches.length !== 1) continue
      const file = matches[0]!
      const digest = inputs[file]!
      const start = end.startLoc?.position
      const finish = end.endLoc?.position
      if (
        !/^[a-f0-9]{64}$/.test(digest) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(finish) ||
        start! < 0 ||
        finish! <= start!
      ) {
        continue
      }
      keys.push({
        group: JSON.stringify([file, digest, clone.format]),
        start: start!,
        finish: finish!,
        file,
        hash: digest,
        format: clone.format,
        fragment: clone.fragment,
        firstLine: end.start ?? 0,
        lastLine: end.end ?? 0,
        startColumn: end.startLoc?.column ?? 0,
        endColumn: end.endLoc?.column ?? 0
      })
    }
    return keys
  }

  function pairKey(entries: [CloneOccurrenceKey, CloneOccurrenceKey]): string {
    return JSON.stringify([
      entries[0].format,
      entries[0].fragment,
      entries.map((e) => e.file).sort()
    ])
  }

  function matchesMovedPair(entries: [CloneOccurrenceKey, CloneOccurrenceKey]): boolean {
    if (!readSource) return false
    const candidates = priorPairs.get(pairKey(entries))
    if (!candidates) return false
    const blocks = entries.map((entry) => uniqueCloneBlock(entry, readSource))
    if (!blocks.every(Boolean)) return false
    return candidates.some((prior) =>
      (
        [
          prior,
          [prior[1], prior[0]]
        ] as Array<[CloneOccurrenceKey, CloneOccurrenceKey]>
      ).some(
        (pair) =>
          pair.some((entry, i) => entry.hash !== entries[i]!.hash) &&
          pair.every(
            (entry, i) =>
              entry.file === entries[i]!.file &&
              blocks[i] === uniqueCloneBlock(entry, readSource)
          )
      )
    )
  }

  for (const record of baseline) {
    const entries = occurrences(record, beforeInputs)
    if (entries.length !== 2) continue
    const pair: [CloneOccurrenceKey, CloneOccurrenceKey] = [entries[0]!, entries[1]!]
    if (readSource) {
      const key = pairKey(pair)
      if (!priorPairs.has(key)) priorPairs.set(key, [])
      priorPairs.get(key)!.push(pair)
    }
    for (const item of pair) {
      if (!priorOccurrences.has(item.group)) priorOccurrences.set(item.group, [])
      priorOccurrences.get(item.group)!.push(item)
    }
  }

  function alreadyCovered(item: CloneOccurrenceKey): boolean {
    return Boolean(
      priorOccurrences.get(item.group)?.some((prior) => {
        if (prior.fragment === item.fragment) {
          return prior.start === item.start && prior.finish === item.finish
        }
        return (
          prior.start <= item.start &&
          item.finish <= prior.finish &&
          prior.fragment.includes(item.fragment)
        )
      })
    )
  }

  return current.filter((record) => {
    if (exact.has(record)) return false
    const keys = occurrences(record, afterInputs)
    if (keys.length !== 2) return true
    const pair: [CloneOccurrenceKey, CloneOccurrenceKey] = [keys[0]!, keys[1]!]
    return !pair.every(alreadyCovered) && !matchesMovedPair(pair)
  })
}

export function assessCleanupVerification({
  change,
  checks = [],
  counterexample = null,
  evidenceGaps = []
}: {
  change?: { ok?: boolean; errors?: string[] } | null
  checks?: Array<{
    id?: string
    status?: string
    execution?: string
    verdict?: string
  }>
  counterexample?: string | null
  evidenceGaps?: Array<{ source: string; detail: string }>
}): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  if (!change?.ok) errors.push(...(change?.errors || ['cleanup diff failed']))
  for (const check of checks) {
    const passed =
      check.status === 'success' ||
      (check.execution === 'success' && ['pass', 'review'].includes(check.verdict ?? ''))
    if (!passed) errors.push(`${check.id || 'check'} did not pass`)
  }
  if (counterexample) errors.push(`differential counterexample found: ${counterexample}`)
  if (evidenceGaps.length) {
    errors.push(...evidenceGaps.map((gap) => `${gap.source}: ${gap.detail}`))
  }
  return { ok: errors.length === 0, errors }
}

export function extractCounterexample(text: unknown): string | null {
  const source = String(text || '')
  if (!/Counterexample:/i.test(source)) return null
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => /Counterexample:/i.test(line))
  return lines
    .slice(start, start + 8)
    .filter((line) => /Counterexample:|seed:|path:|Shrunk/i.test(line))
    .join('\n')
}

export function buildEvidenceGap(
  source: string,
  detail: string
): { source: string; status: 'missing'; detail: string } {
  return { source, status: 'missing', detail }
}

export function buildDeletionDecision(item: Partial<LedgerCandidate> | undefined | null) {
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
  ) {
    return null
  }
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

export function changedFilesFromSnapshots(
  before?: { inputs?: Record<string, string> } | null,
  after?: { inputs?: Record<string, string> } | null
): string[] {
  const keys = new Set([
    ...Object.keys(before?.inputs || {}),
    ...Object.keys(after?.inputs || {})
  ])
  return [...keys].filter((file) => before?.inputs?.[file] !== after?.inputs?.[file]).sort()
}

export function readDiffStats(root: string, files: string[]): Required<DiffChange>[] {
  if (!files.length) return []
  const run = executeCommand(
    ['git', 'diff', '--numstat', '--no-renames', 'HEAD', '--', ...files],
    root
  )
  if (run.code !== 0) throw new Error(run.stderr || run.error || 'git diff failed')
  const rows = new Map<string, Required<DiffChange>>()
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
    const entry = fs.lstatSync(absolute, { throwIfNoEntry: false })
    let additions = 0
    if (entry?.isFile()) additions = fs.readFileSync(absolute, 'utf8').split(/\r?\n/).length
    else if (entry?.isSymbolicLink() || entry?.isDirectory()) additions = 1
    else if (entry) throw new Error(`Unsupported changed entry: ${file}`)
    rows.set(file, { file, additions, deletions: 0 })
  }
  return [...rows.values()]
}

function parseTool(run: CommandResult, id: string, artifact: string) {
  return {
    id,
    status: run.code === 0 ? 'success' : run.code === 1 ? 'findings' : 'error',
    exitCode: run.code,
    artifact,
    detail: run.error || run.stderr || run.stdout
  }
}

interface StoredQualityResults {
  results?: Array<{
    id: string
    findings?: string[]
    report?: string
    [key: string]: unknown
  }>
}

function resolveWorkspaceFile(root: string, file: string): string | null {
  const clean = file.replace(/^\.\//, '')
  if (fs.existsSync(path.join(root, clean))) return clean
  const matches = ['apps', 'packages', 'plugins', 'scripts', 'tests']
    .map((prefix) => `${prefix}/${clean}`)
    .filter((cand) => fs.existsSync(path.join(root, cand)))
  return matches.length === 1 ? matches[0]! : null
}

function readQualityOutcome(root: string, runDir: string) {
  const results = safeReadJson<StoredQualityResults | null>(path.join(runDir, 'results.json'), null)
  if (!results) {
    return {
      files: [] as string[],
      defaultFiles: [] as string[],
      productionOnlyFiles: [] as string[],
      issues: [] as NonNullable<BuildLedgerReports['knip']>['issues'],
      duplicates: [] as JscpdDuplicateEntry[],
      unresolvedDuplicates: [] as unknown[],
      results: null
    }
  }
  const knip = results.results?.filter((item) => item.id.startsWith('knip')) || []
  const unusedFiles = (runs: typeof knip) =>
    runs.flatMap((item) =>
      (item.findings || [])
        .filter((finding) => finding.startsWith('unused-file:'))
        .map((finding) => finding.slice('unused-file:'.length))
    )
  const defaultFiles = new Set(unusedFiles(knip.filter((item) => item.id === 'knip')))
  const files = [...new Set(unusedFiles(knip))]
  const jscpdItem = results.results?.find((item) => item.id === 'jscpd')
  const reportPath = jscpdItem?.report
  const report = reportPath
    ? safeReadJson<{ duplicates?: JscpdDuplicateEntry[] } | null>(
        path.resolve(root, reportPath),
        null
      )
    : null
  const normalized = normalizeJscpdDuplicates(report?.duplicates || [], (file) =>
    resolveWorkspaceFile(root, file)
  )
  return {
    results,
    files,
    defaultFiles: [...defaultFiles],
    productionOnlyFiles: files.filter((file) => !defaultFiles.has(file)),
    issues: knip.flatMap((item) =>
      (item.findings || [])
        .filter((finding) => !finding.startsWith('unused-file:'))
        .map((finding) => {
          const [file, category, ...valueParts] = finding.split(':')
          return {
            file,
            category,
            mode:
              item.id === 'knip'
                ? 'default'
                : item.id === 'knip-production'
                  ? 'production'
                  : undefined,
            value: valueParts.join(':'),
            finding
          }
        })
    ),
    duplicates: normalized.duplicates,
    unresolvedDuplicates: normalized.unresolved
  }
}

export function readDebtRegistry(
  root: string,
  changedFiles: string[] = [],
  now?: Date
): {
  registry: DebtRegistry
  ok: boolean
  errors: string[]
  actionable: ActionableDebt[]
} {
  const registry = safeReadJson<DebtRegistry>(path.join(root, DEBT_REGISTRY), {
    schemaVersion: 1,
    items: []
  })
  const contents: Record<string, string> = {}
  for (const item of registry.items || []) {
    for (const tgt of item.targets || []) {
      const absolute = path.join(root, tgt.file)
      if (fs.existsSync(absolute)) contents[tgt.file] = fs.readFileSync(absolute, 'utf8')
    }
  }
  const markers = extractCleanupDebtMarkers(contents)
  return {
    registry,
    ...validateCleanupDebt(registry, {
      ...(now ? { now } : {}),
      markers,
      changedFiles
    })
  }
}

function runStructuralTools(
  root: string,
  item: LedgerCandidate,
  outDir: string,
  changedFiles: string[] = [],
  runTool: (command: string[], cwd?: string) => CommandResult = (cmd, cwd = root) =>
    executeCommand(cmd, cwd)
) {
  const evidenceGaps: Array<{ source: string; status: 'missing'; detail: string }> = []
  const runs = []
  const files = item.targets.map((t) => t.file)
  if (item.tools?.astGrep) {
    const artifact = path.join(outDir, 'ast-grep.json')
    const run = runTool(
      ['ast-grep', 'scan', '--config', item.tools.astGrep, '--json=compact', ...files],
      root
    )
    if (run.error?.includes('ENOENT')) {
      evidenceGaps.push(buildEvidenceGap('ast-grep', run.error))
    } else {
      fs.writeFileSync(artifact, run.stdout)
      runs.push(parseTool(run, 'ast-grep', artifact))
    }
  }
  if (item.tools?.semgrepRules) {
    const artifact = path.join(outDir, 'semgrep.json')
    const run = runTool(
      [
        'semgrep',
        'scan',
        '--metrics=off',
        '--config',
        item.tools.semgrepRules,
        '--autofix',
        '--dryrun',
        '--json',
        ...files
      ],
      root
    )
    if (run.error?.includes('ENOENT')) {
      evidenceGaps.push(buildEvidenceGap('semgrep', run.error))
    } else {
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
    if (run.error?.includes('ENOENT')) {
      evidenceGaps.push(buildEvidenceGap('semgrep', run.error))
    } else {
      fs.writeFileSync(artifact, run.stdout)
      runs.push(parseTool(run, 'semgrep-sensitive', artifact))
    }
  }
  return { runs, evidenceGaps }
}

function ratchetCommand(runDir: string): string[] {
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

function packageForFile(root: string, file: string): string | null {
  let directory = path.dirname(path.join(root, file))
  while (directory.startsWith(root)) {
    const manifest = path.join(directory, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string }
        if (typeof pkg.name === 'string' && pkg.name !== 'action-driver') return pkg.name
      } catch {
        // ignore invalid manifest
      }
      return null
    }
    if (directory === root) break
    directory = path.dirname(directory)
  }
  return null
}

function runTargetedChecks(
  root: string,
  item: LedgerCandidate,
  tests: string[],
  outDir: string,
  execute: (command: string[]) => CommandResult
) {
  const changed = item.targets
    .map((t) => t.file)
    .filter((file) => fs.existsSync(path.join(root, file)))
  const commands: Array<{ id: string; command: string[] }> = []
  if (changed.length) {
    commands.push({
      id: 'eslint-targets',
      command: ['pnpm', 'exec', 'eslint', ...changed, '--format', 'json']
    })
  }
  const packages = [
    ...new Set(
      item.targets
        .map((t) => packageForFile(root, t.file))
        .filter((name): name is string => Boolean(name))
    )
  ]
  for (const name of packages) {
    commands.push({ id: `typecheck:${name}`, command: ['pnpm', '--filter', name, 'typecheck'] })
  }
  if (tests.length) {
    commands.push({ id: 'related-tests', command: ['pnpm', 'exec', 'vitest', 'run', ...tests] })
  }
  return commands.map(({ id, command }) => {
    const artifact = path.join(outDir, `${id.replaceAll(/[^a-z0-9_-]+/gi, '-')}.log`)
    const run = execute(command)
    fs.writeFileSync(artifact, `${run.stdout || ''}\n${run.stderr || ''}\n${run.error || ''}`)
    return parseTool(run, id, artifact)
  })
}

function knipRunToQualityRow(
  mode: KnipMode,
  run: KnipRun,
  now: Date,
  configDigest?: string,
  scope: string[] = []
) {
  const findings = run.observations.map((obs) =>
    obs.rule === 'files'
      ? `unused-file:${obs.target}`
      : `${obs.target}:${obs.rule}:${obs.symbol}`
  )
  return {
    id: mode === 'default' ? 'knip' : 'knip-production',
    tool: 'knip',
    parser: 'knip',
    required: true,
    scope,
    execution: 'success',
    verdict: findings.length ? 'findings' : 'pass',
    findingsComparable: true,
    findings,
    notes: findings.length ? `${findings.length} findings` : 'no findings within declared scope',
    toolVersion: run.version,
    exitCode: run.exitCode,
    started: now.toISOString(),
    ended: now.toISOString(),
    configDigest
  }
}

export async function prepareCleanup({
  root = process.cwd(),
  out,
  now = new Date(),
  ports = {},
  shared,
  commandOptions = {}
}: {
  root?: string | undefined
  out: string
  now?: Date | undefined
  ports?:
    | {
        snapshot?: (() => RepoSnapshot) | undefined
        execute?: ((command: string[], cwd?: string) => CommandResult) | undefined
      }
    | undefined
  shared?:
    | {
        snapshot?: FactSnapshot | undefined
        knipRuns?: Array<{ mode: KnipMode; run: KnipRun }> | undefined
        debtAsOf?: string | undefined
      }
    | undefined
  commandOptions?: CommandResolutionOptions | undefined
}) {
  if (!out) throw new Error('prepare requires --out artifacts/test-reports/redundant-code/<run>')
  if (!ports.execute) assertQualityNode()
  const snapshot = ports.snapshot || (() => snapshotRepo(root))
  const execute = ports.execute || executeFor(root, commandOptions)
  const before = snapshot()
  if (fs.existsSync(path.resolve(root, out))) {
    throw new Error('cleanup run directory already exists; choose a new run')
  }

  const toolRuns = []
  if (ports.execute) {
    for (const command of [
      [process.execPath, 'scripts/audit-redundant/run-all.mjs', '--out', out],
      [process.execPath, 'scripts/audit-redundant/run-deep.mjs', '--out', out]
    ]) {
      const run = execute(command)
      toolRuns.push(parseTool(run, command[1]!.split('/').at(-1)!.replace('.mjs', ''), out))
      if (run.code !== 0) break
    }
  } else {
    for (const [id, stage] of [
      ['run-all', 'all'],
      ['run-deep', 'deep']
    ] as const) {
      try {
        runAuditStage(stage, root, out, { snapshot })
        toolRuns.push({
          id,
          status: 'success',
          exitCode: 0,
          artifact: out,
          detail: `Completed ${stage}`
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toolRuns.push({
          id,
          status: 'error',
          exitCode: 2,
          artifact: out,
          detail: message
        })
        break
      }
    }
  }

  const passedSharedKnip = (shared?.knipRuns ?? []).filter((item) => item.run.status === 'passed')
  const hasSharedDefault = passedSharedKnip.some((item) => item.mode === 'default')
  const hasSharedProd = passedSharedKnip.some((item) => item.mode === 'production')
  const sharedKnipUsed = hasSharedDefault || hasSharedProd
  const onlyList = [
    ...(hasSharedDefault ? [] : ['knip']),
    ...(hasSharedProd ? [] : ['knip-production']),
    'jscpd'
  ]

  const qualityDir = `${out}/baseline-quality`
  if (ports.execute) {
    const qualityRun = execute([
      process.execPath,
      'scripts/local-quality/run.mjs',
      '--mode',
      'full',
      '--only',
      onlyList.join(','),
      '--out',
      qualityDir
    ])
    toolRuns.push(parseTool(qualityRun, 'baseline-quality', qualityDir))
  } else {
    try {
      const q = await runLocalQuality({
        mode: 'full',
        repo: root,
        out: qualityDir,
        only: onlyList,
        commandOptions
      })
      toolRuns.push({
        id: 'baseline-quality',
        status: q.exitCode === 0 ? 'success' : q.exitCode === 1 ? 'findings' : 'error',
        exitCode: q.exitCode,
        artifact: qualityDir,
        detail: q.summaryPath ?? ''
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toolRuns.push({
        id: 'baseline-quality',
        status: 'error',
        exitCode: 2,
        artifact: qualityDir,
        detail: message
      })
    }
  }

  if (sharedKnipUsed) {
    const resultsFile = path.join(root, qualityDir, 'results.json')
    const existing = safeReadJson<{ results?: Array<{ id: string; [key: string]: unknown }> }>(
      resultsFile,
      { results: [] }
    )
    const sharedRows = passedSharedKnip.map(({ mode, run }) =>
      knipRunToQualityRow(mode, run, now, before.configDigest, shared?.snapshot?.scope ?? [])
    )
    const sharedIds = new Set(sharedRows.map((r) => r.id))
    const mergedResults = [
      ...sharedRows,
      ...(existing.results || []).filter((r) => !sharedIds.has(r.id))
    ]
    fs.mkdirSync(path.dirname(resultsFile), { recursive: true })
    fs.writeFileSync(
      resultsFile,
      JSON.stringify({ ...existing, results: mergedResults }, null, 2) + '\n'
    )
  }

  const after = snapshot()
  if (after.digest !== before.digest) {
    throw new Error('workspace changed during cleanup prepare; evidence is stale')
  }
  const scan = safeReadJson<ScanRecord | null>(path.join(root, out, 'scan.json'), null)
  if (!scan?.stages?.includes('all') || !scan.stages.includes('deep')) {
    throw new Error('completed all + deep audit evidence is required')
  }
  if (scan.snapshot?.digest !== before.digest) {
    throw new Error('audit snapshot does not match current workspace')
  }

  const quality = readQualityOutcome(root, path.join(root, qualityDir))
  if (quality.unresolvedDuplicates.length) {
    toolRuns.push({
      id: 'cleanup-jscpd-paths',
      status: 'error',
      exitCode: 1,
      artifact: `${qualityDir}/jscpd/jscpd-report.json`,
      detail: `${quality.unresolvedDuplicates.length} duplicate blocks could not be mapped to a unique workspace path`
    })
  }
  const reports: BuildLedgerReports = {
    audit: safeReadJson(path.join(root, out, 'false-positive-refined.json'), {}),
    symbols: safeReadJson(path.join(root, out, 'symbol-dead-code.json'), {}),
    deadTests: safeReadJson(path.join(root, out, 'dead-tests.json'), {}),
    knip: {
      files: quality.defaultFiles,
      productionOnlyFiles: quality.productionOnlyFiles,
      issues: quality.issues ?? []
    },
    jscpd: { duplicates: quality.duplicates },
    results: quality.results
  }
  const debtNow = shared?.debtAsOf ? new Date(`${shared.debtAsOf}T00:00:00Z`) : now
  const debt = readDebtRegistry(root, [], debtNow)
  if (!debt.ok) {
    toolRuns.push({
      id: 'cleanup-debt',
      status: 'error',
      exitCode: 1,
      artifact: DEBT_REGISTRY,
      detail: debt.errors.join('; ')
    })
  }
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
    exitCode: toolRuns.every((run) => run.status !== 'error') ? 0 : 2,
    sharedKnipUsed
  }
}

export async function verifyCleanup({
  root = process.cwd(),
  run,
  candidateId,
  tests = [],
  now = new Date(),
  ports = {},
  commandOptions = {}
}: {
  root?: string | undefined
  run: string
  candidateId: string
  tests?: string[] | undefined
  now?: Date | undefined
  ports?:
    | {
        snapshot?: (() => RepoSnapshot) | undefined
        diffStats?: ((files: string[]) => Required<DiffChange>[]) | undefined
        execute?: ((command: string[], cwd?: string) => CommandResult) | undefined
      }
    | undefined
  commandOptions?: CommandResolutionOptions | undefined
}) {
  if (!run || !candidateId) throw new Error('verify requires --run and --candidate')
  if (!ports.execute) assertQualityNode()
  const snapshot = ports.snapshot || (() => snapshotRepo(root))
  const execute = ports.execute || executeFor(root, commandOptions)
  const ledgerPath = path.join(root, run, 'cleanup-ledger.json')
  const ledger = safeReadJson<CleanupLedger | null>(ledgerPath, null)
  if (!ledger) throw new Error('cleanup-ledger.json not found')
  const schema = validateCleanupLedger(ledger)
  if (!schema.ok) throw new Error(schema.errors.join('; '))
  const item = ledger.candidates.find((row) => row.id === candidateId)
  if (!item) throw new Error(`unknown candidate: ${candidateId}`)
  const action = actionForCandidate(item)
  if (!action.allowed) throw new Error(`candidate is not executable: ${action.reasons.join('; ')}`)

  const current = snapshot()
  const files = changedFilesFromSnapshots(ledger.snapshot, current)
  const stats = (ports.diffStats || ((rows: string[]) => readDiffStats(root, rows)))(files)
  const change = validateCleanupDiff(item, stats)
  const debt = readDebtRegistry(root, files, now)
  const verifyDir = path.join(root, run, `verify-${candidateId}`)
  if (fs.existsSync(verifyDir)) throw new Error(`verification already exists: ${verifyDir}`)
  fs.mkdirSync(verifyDir, { recursive: true })

  const tools = runStructuralTools(root, item, verifyDir, files, execute)
  const selectedTests = tests.length ? tests : item.tests || []
  for (const test of selectedTests) {
    if (
      typeof test !== 'string' ||
      test.startsWith('-') ||
      path.isAbsolute(test) ||
      test.split(/[\\/]/).includes('..')
    ) {
      throw new Error('Invalid test path')
    }
    const abs = path.resolve(root, test)
    if (fs.realpathSync(abs) !== abs || !fs.statSync(abs).isFile()) {
      throw new Error('Expected a regular project test file')
    }
  }
  const targeted = runTargetedChecks(root, item, selectedTests, verifyDir, (cmd) => execute(cmd))
  const counterexample = extractCounterexample(
    targeted
      .map((check) => {
        const artifact = path.resolve(root, check.artifact)
        return fs.existsSync(artifact) ? fs.readFileSync(artifact, 'utf8') : ''
      })
      .join('\n')
  )
  const ratchetDir = path.join(verifyDir, 'ratchet')
  let ratchetRun: { code: number | null }
  if (ports.execute) {
    ratchetRun = execute(ratchetCommand(path.relative(root, ratchetDir)))
  } else {
    const q = await runLocalQuality({
      mode: 'full',
      repo: root,
      out: path.relative(root, ratchetDir),
      only: ['knip', 'knip-production', 'jscpd'],
      commandOptions
    })
    ratchetRun = { code: q.exitCode }
  }
  const ratchet = readQualityOutcome(root, ratchetDir)

  const checks: Array<{
    id: string
    status: string
    exitCode: number | null
    artifact: string
    detail: string
  }> = [...targeted, ...tools.runs]
  const evidenceGaps = [...tools.evidenceGaps]
  if (targeted.length === 0) {
    evidenceGaps.push(buildEvidenceGap('targeted-checks', 'no target or test checks selected'))
  }
  if (!ratchet.results) evidenceGaps.push(buildEvidenceGap('ratchet', 'missing results.json'))
  if (!debt.ok) {
    evidenceGaps.push(...debt.errors.map((detail) => buildEvidenceGap('cleanup-debt', detail)))
  }
  const baseline = safeReadJson<StoredQualityResults | null>(
    path.join(root, run, 'baseline-quality/results.json'),
    null
  )
  const baselineQuality = baseline
    ? {
        files: (baseline.results || [])
          .filter((r) => r.id?.startsWith('knip'))
          .flatMap((r) =>
            (r.findings || [])
              .filter((finding) => finding.startsWith('unused-file:'))
              .map((finding) => finding.slice('unused-file:'.length))
          ),
        duplicates: (baseline.results || []).find((r) => r.id === 'jscpd')?.findings || []
      }
    : { files: [] as string[], duplicates: [] as string[] }
  const newUnusedFiles = ratchet.files.filter((file) => !baselineQuality.files.includes(file))
  const currentDuplicates = ratchet.results?.results?.find((r) => r.id === 'jscpd')?.findings
  if (
    !baseline ||
    !Array.isArray(currentDuplicates) ||
    !Array.isArray(baseline.results?.find((r) => r.id === 'jscpd')?.findings)
  ) {
    evidenceGaps.push(buildEvidenceGap('jscpd-ratchet', 'missing comparable jscpd findings'))
  }
  const newDuplicates = newDuplicateRecords(
    baselineQuality.duplicates,
    currentDuplicates || [],
    ledger.snapshot.inputs,
    current.inputs,
    snapshotSourceReader(root, ledger.snapshot.head ?? '')
  )
  if (newUnusedFiles.length) {
    evidenceGaps.push(
      buildEvidenceGap('knip-ratchet', `new unused files: ${newUnusedFiles.join(', ')}`)
    )
  }
  if (newDuplicates.length) {
    evidenceGaps.push(
      buildEvidenceGap('jscpd-ratchet', `new duplicate clones: ${newDuplicates.length}`)
    )
  }
  checks.push({
    id: 'ratchet',
    status:
      !ratchet.results ||
      (ratchetRun.code !== null && ratchetRun.code > 1) ||
      newUnusedFiles.length ||
      newDuplicates.length
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
  fs.writeFileSync(path.join(verifyDir, 'verification.json'), JSON.stringify(result, null, 2) + '\n')
  item.state = assessment.ok ? 'verified' : item.state
  item.verification = {
    ok: assessment.ok,
    path: path.relative(root, path.join(verifyDir, 'verification.json')),
    errors: assessment.errors
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n')
  return { ...result, exitCode: assessment.ok ? 0 : 1 }
}

export function renderCleanupSummary(
  ledger: CleanupLedger,
  { debt, quality }: { debt?: { actionable?: unknown[] }; quality?: unknown } = {}
): string {
  const counts = ledger.candidates.reduce<Record<string, number>>((acc, item) => {
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

export async function deleteFile({
  root,
  run,
  candidate,
  apply = false,
  execute,
  denyPatterns = []
}: {
  root: string
  run: string
  candidate: string
  apply?: boolean | undefined
  execute?: ((command: string[], cwd?: string) => CommandResult) | undefined
  denyPatterns?: readonly RegExp[] | undefined
}) {
  const ledger = safeReadJson<CleanupLedger | null>(path.join(root, run, 'cleanup-ledger.json'), null)
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

  if (execute) {
    const prepared = execute(
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
    if (prepared.code !== 0) {
      throw new Error(prepared.stderr || prepared.error || 'review preparation failed')
    }
    const manifest = path.join(targetDir, 'reviewed.json')
    const removal = execute(
      [
        process.execPath,
        'scripts/audit-redundant/13-remove-proven.mjs',
        `--from=${path.relative(root, manifest)}`,
        apply ? '--apply' : '--dry-run'
      ],
      root
    )
    if (removal.code !== 0) throw new Error(removal.stderr || removal.error || 'deletion failed')
    return JSON.parse(removal.stdout) as { mode: string; wouldDelete: string[]; deleted?: string[] }
  }

  const out = assertArtifactDir(root, path.relative(root, targetDir))
  const scan = JSON.parse(fs.readFileSync(path.join(out, 'scan.json'), 'utf8')) as ScanRecord
  const manifestData: RemovalManifest = {
    schema: 1,
    snapshot: scan.snapshot?.digest,
    items: [decision]
  }
  const inspectFile = (rel: string) => {
    const abs = path.join(root, rel)
    const st = fs.lstatSync(abs)
    return {
      regular: st.isFile(),
      symlink: st.isSymbolicLink() || fs.realpathSync(abs) !== abs
    }
  }
  validateRemoval(manifestData, scan, snapshotRepo(root), inspectFile, denyPatterns)
  const reviewedFile = path.join(out, 'reviewed.json')
  fs.writeFileSync(reviewedFile, JSON.stringify(manifestData, null, 2) + '\n', { flag: 'wx' })
  const report = applyRemoval(
    manifestData,
    scan,
    apply,
    {
      snapshot: () => snapshotRepo(root),
      inspect: inspectFile,
      remove: (rel) => fs.unlinkSync(path.join(root, rel))
    },
    denyPatterns
  )
  fs.writeFileSync(
    path.join(out, 'last-remove-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
  return report
}

export const readDebt = readDebtRegistry

interface PipelineCliOptions {
  help?: boolean | undefined
  command?: string | undefined
  out?: string | undefined
  run?: string | undefined
  candidate?: string | undefined
  tests?: string[] | undefined
  apply?: boolean | undefined
}

function parsePipelineCliArgs(argv: string[]): PipelineCliOptions {
  if (argv.length === 0 || argv[0] === '--help') return { help: true }
  const [command, ...rest] = argv
  const options: PipelineCliOptions = { command }
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!
    if (arg === '--') continue
    if (arg === '--help') options.help = true
    else if (['--out', '--run', '--candidate', '--tests'].includes(arg)) {
      const value = rest[++index]
      if (!value || value.startsWith('--')) throw new Error(`missing value: ${arg}`)
      if (arg === '--tests') options.tests = value.split(',')
      else if (arg === '--out') options.out = value
      else if (arg === '--run') options.run = value
      else if (arg === '--candidate') options.candidate = value
    } else if (arg === '--apply') options.apply = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

export async function runCleanupPipelineCli(
  argv: string[] = process.argv.slice(2),
  root: string = process.cwd(),
  extra: {
    commandOptions?: CommandResolutionOptions | undefined
    denyPatterns?: readonly RegExp[] | undefined
  } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const options = parsePipelineCliArgs(argv)
  if (options.help || !options.command) {
    return {
      exitCode: 0,
      stdout:
        'Usage:\n  node scripts/audit-redundant/cleanup-pipeline.mjs prepare --out artifacts/test-reports/redundant-code/<run>\n  node scripts/audit-redundant/cleanup-pipeline.mjs verify --run <run> --candidate <id> [--tests path,path]\n  node scripts/audit-redundant/cleanup-pipeline.mjs delete-file --run <run> --candidate <id> [--apply]\n  node scripts/audit-redundant/cleanup-pipeline.mjs check-debt\nPrepare runs existing audit all/deep and Knip/jscpd quality checks. Verify never edits source. delete-file defaults to dry-run.\n',
      stderr: ''
    }
  }
  if (options.command === 'prepare') {
    const result = await prepareCleanup({
      root,
      out: options.out ?? '',
      commandOptions: extra.commandOptions
    })
    return {
      exitCode: result.exitCode,
      stdout: `${result.ledgerPath}\n`,
      stderr: ''
    }
  }
  if (options.command === 'verify') {
    const result = await verifyCleanup({
      root,
      run: options.run ?? '',
      candidateId: options.candidate ?? '',
      tests: options.tests || [],
      commandOptions: extra.commandOptions
    })
    return {
      exitCode: result.exitCode,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: ''
    }
  }
  if (options.command === 'delete-file') {
    const result = await deleteFile({
      root,
      run: options.run ?? '',
      candidate: options.candidate ?? '',
      apply: options.apply,
      denyPatterns: extra.denyPatterns
    })
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: ''
    }
  }
  if (options.command === 'check-debt') {
    const result = readDebtRegistry(root)
    return {
      exitCode: result.ok ? 0 : 1,
      stdout: `${JSON.stringify(result, null, 2)}\n`,
      stderr: ''
    }
  }
  throw new Error(`unknown command: ${options.command}`)
}
