import type {
  CleanupEvidence,
  CleanupGap,
  CleanupResult,
  Debt,
  FactSnapshot,
  KnipMode,
  KnipRun,
  Observation
} from '@architecture-kit/core-ir'
import type { CleanupConfig, CleanupPorts } from '@architecture-kit/ports'
import { findingsFrom } from './policy.js'
import { renderReport } from './report.js'

export type { CleanupResult }

type Baseline = { roundId: string; comparisonKey: string; findingIds: string[] }
type Context = {
  root: string
  output: string
  config: CleanupConfig
  signal: AbortSignal
  ports: CleanupPorts
  loadFacts: () => Promise<FactSnapshot>
  progress?: (message: string) => void
  baseline?: Baseline[]
  storageRoot?: string
  debtAsOf?: string
}

export async function check({
  root,
  output,
  config,
  signal,
  ports,
  loadFacts,
  progress = () => {},
  baseline = [],
  storageRoot = '.architecture-kit',
  debtAsOf
}: Context) {
  const generated = storageRoot
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/')
  progress('采集项目快照')
  const snapshot = await loadFacts()
  progress('扫描范围：' + snapshot.scope.length + ' 个工作区成员')
  const coverageGaps: CleanupGap[] = [],
    evidence: CleanupEvidence[] = [],
    runs: { file: string; observations: Observation[] }[] = [],
    knipRuns: Array<{ mode: KnipMode; run: KnipRun }> = []
  const toolVersions: Record<string, string> = {}
  let configDigest: string | null = null
  let skip: string | null = null
  async function save(file: string, data: unknown) {
    await ports.writeEvidence(output, file, JSON.stringify(data, null, 2) + '\n')
  }
  function register(
    file: string,
    status: CleanupEvidence['status'],
    reason: string | null,
    required: boolean
  ) {
    evidence.push({ file, status, reason, required })
    if (reason && reason !== 'disabled') coverageGaps.push({ file, reason, required })
  }
  async function hooks(phase: 'check.start' | 'check.end') {
    for (const hook of config.hooks[phase]) {
      const dir = 'hooks/' + phase + '/' + hook.id
      const skipped = signal.aborted ? 'interrupted' : skip
      if (!skipped) progress('开始 hook ' + phase + '/' + hook.id)
      const exec = skipped
        ? { exitCode: null, stdout: '', stderr: '' }
        : await ports.runHook(root, hook, signal)
      const status = skipped ? 'skipped' : exec.exitCode === 0 ? 'passed' : 'failed'
      const reason = skipped ?? (status === 'failed' ? 'hook-failed' : null)
      await save(dir + '/result.json', {
        schemaVersion: 1,
        phase,
        hook,
        status,
        reason,
        exitCode: exec.exitCode
      })
      if (exec.stdout) await ports.writeEvidence(output, dir + '/stdout.log', exec.stdout)
      if (exec.stderr) await ports.writeEvidence(output, dir + '/stderr.log', exec.stderr)
      progress(
        'hook ' +
          phase +
          '/' +
          hook.id +
          ' · ' +
          status +
          (exec.exitCode === null ? '' : ' · exit ' + exec.exitCode) +
          (reason ? ' · ' + reason : '') +
          (status === 'failed' ? ' · ' + dir + '/result.json' : '')
      )
      register(dir + '/result.json', status, reason, hook.required)
      if (!skipped && status === 'failed' && hook.required && phase === 'check.start')
        skip = 'required-start-hook-failed'
    }
  }
  await hooks('check.start')
  const tool = config.tools.knip
  for (const mode of tool.modes) {
    const dir = 'tools/knip/' + mode
    const skipped = signal.aborted ? 'interrupted' : (skip ?? (!tool.enabled ? 'disabled' : null))
    if (!skipped) progress('开始 Knip ' + mode)
    const run = skipped
      ? {
          status: 'skipped' as const,
          reason: skipped,
          stdout: '',
          stderr: '',
          observations: [],
          exitCode: null,
          version: null,
          configDigest: null,
          argv: []
        }
      : await ports.runKnip(root, mode, tool.configFile, signal)
    const { stdout, stderr, observations: rawObservations, ...details } = run
    const observations = rawObservations.filter(
      (o) => o.target !== generated && !o.target.startsWith(generated + '/')
    )
    if (run.version) toolVersions.knip = run.version
    if (run.configDigest) configDigest = run.configDigest
    await ports.writeEvidence(output, dir + '/raw.json', stdout)
    if (stderr) await ports.writeEvidence(output, dir + '/stderr.log', stderr)
    await save(dir + '/result.json', {
      schemaVersion: 1,
      tool: 'knip',
      mode,
      scope: snapshot.scope,
      configFile: tool.configFile,
      ...details,
      observations
    })
    progress(
      'Knip ' +
        mode +
        ' · ' +
        run.status +
        (run.status === 'passed' ? ' · ' + observations.length + ' 条观测' : ' · ' + run.reason)
    )
    register(dir + '/result.json', run.status, run.reason, tool.required)
    runs.push({ file: dir + '/result.json', observations })
    knipRuns.push({ mode, run })
  }
  let audit: CleanupResult['audit'] = null
  let auditLedgerDigest: string | null = null
  if (config.tools.actionDriver?.enabled) {
    const dir = 'tools/action-driver'
    const skipped = signal.aborted ? 'interrupted' : skip
    if (!skipped) progress('开始 Action-Driver 专项审计')
    const execution = skipped
      ? null
      : await ports.runAudit!(root, output, storageRoot, signal, {
          snapshot,
          knipRuns,
          ...(debtAsOf !== undefined ? { debtAsOf } : {})
        })
    const status = skipped ? 'skipped' : execution?.exitCode === 0 ? 'passed' : 'failed'
    const reason = skipped ?? (status === 'failed' ? 'action-driver-audit-failed' : null)
    if (execution?.stdout) await ports.writeEvidence(output, dir + '/stdout.log', execution.stdout)
    if (execution?.stderr) await ports.writeEvidence(output, dir + '/stderr.log', execution.stderr)
    auditLedgerDigest = execution?.ledgerDigest ?? null
    if (execution && (execution.exitCode === 0 || execution.candidates.length))
      audit = {
        ledger: dir + '/audit/cleanup-ledger.json',
        candidates: execution.candidates
      }
    await save(dir + '/result.json', {
      schemaVersion: 1,
      status,
      reason,
      exitCode: execution?.exitCode ?? null,
      ledger: audit?.ledger ?? null,
      candidateCount: audit?.candidates.length ?? 0,
      ...(execution?.sharedKnipUsed !== undefined
        ? { sharedKnipUsed: execution.sharedKnipUsed }
        : {})
    })
    progress(
      'Action-Driver 审计 · ' +
        status +
        (audit ? ' · ' + audit.candidates.length + ' 个候选' : '') +
        (reason ? ' · ' + reason : '')
    )
    register(dir + '/result.json', status, reason, config.tools.actionDriver.required)
  }
  await hooks('check.end')
  let debt: Debt[] = []
  if (config.debt)
    try {
      debt = await ports.readDebt(root, config.debt, debtAsOf ?? '')
    } catch {
      coverageGaps.push({
        file: null,
        reason: 'invalid-debt-registry',
        required: true
      })
    }
  if (!signal.aborted) {
    progress('复核输入快照并汇总证据')
    try {
      const latestDigest = ports.computeDigest
        ? await ports.computeDigest()
        : (await loadFacts()).inputDigest
      if (latestDigest !== snapshot.inputDigest)
        coverageGaps.push({
          file: null,
          reason: 'input-changed',
          required: true
        })
    } catch (error) {
      const file = 'snapshots/final-stderr.log'
      await ports.writeEvidence(
        output,
        file,
        error instanceof Error ? error.message : String(error)
      )
      coverageGaps.push({
        file,
        reason: 'final-snapshot-failed',
        required: true
      })
    }
  }
  const complete = !signal.aborted && !coverageGaps.some((g) => g.required)
  const result: CleanupResult = {
    schemaVersion: 1,
    status: complete ? 'complete' : 'incomplete',
    inputDigest: snapshot.inputDigest,
    scope: snapshot.scope,
    reportPackages: config.reportPackages,
    audit,
    ...findingsFrom(snapshot, runs, debt, config.reportPackages),
    evidence,
    coverageGaps
  }
  const key = JSON.stringify([
    1,
    config,
    configDigest,
    toolVersions,
    snapshot.scope,
    evidence.map((e) => [e.file, e.status])
  ])
  const comparisonKey = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  ).toString('hex')
  const comparable = complete && (!tool.enabled || configDigest !== null)
  const previous = comparable ? baseline.find((b) => b.comparisonKey === comparisonKey) : undefined
  const current = new Set(result.findings.map((f) => f.id))
  const earlier = new Set(previous?.findingIds)
  const comparison = previous
    ? {
        status: 'compared',
        roundId: previous.roundId,
        added: [...current].filter((id) => !earlier.has(id)),
        existing: [...current].filter((id) => earlier.has(id)),
        resolved: [...earlier].filter((id) => !current.has(id)).sort()
      }
    : {
        status: comparable && !baseline.length ? 'first' : 'incomparable',
        roundId: null
      }
  return {
    auditLedgerDigest,
    debtAsOf: debt.length ? debtAsOf : null,
    result,
    report: renderReport(result),
    complete,
    toolVersions,
    inputDigest: snapshot.inputDigest,
    comparisonKey,
    comparison
  }
}
