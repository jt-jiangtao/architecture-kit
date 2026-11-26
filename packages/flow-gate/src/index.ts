import type {
  GateCheckOutcome,
  GateProfileName,
  GateResult
} from '@architecture-kit/core-ir'
import type { GateCheckConfig, GateConfig, GatePorts } from '@architecture-kit/ports'

export interface GateRunOptions {
  root: string
  config: GateConfig
  profile?: GateProfileName | undefined
  groups?: readonly string[] | undefined
  only?: readonly string[] | undefined
  failFast?: boolean | undefined
  changedFiles?: readonly string[] | undefined
  signal: AbortSignal
}

export function selectGateChecks(
  config: GateConfig,
  options: {
    profile?: GateProfileName | undefined
    groups?: readonly string[] | undefined
    only?: readonly string[] | undefined
  }
): { profile: GateProfileName; checks: GateCheckConfig[]; groups: string[] } {
  const profile = options.profile ?? config.defaultProfile
  const onlySet = options.only && options.only.length > 0 ? new Set(options.only) : undefined
  const groupSet =
    options.groups && options.groups.length > 0 ? new Set(options.groups) : undefined

  if (onlySet) {
    const known = new Set(config.checks.map((c) => c.id))
    for (const id of onlySet) {
      if (!known.has(id)) {
        throw new Error(`Unknown gate check ID: ${id}`)
      }
    }
  }

  const selected = config.checks.filter((check) => {
    if (onlySet) return onlySet.has(check.id)
    if (!check.profiles.includes(profile)) return false
    if (groupSet && !groupSet.has(check.group)) return false
    return true
  })

  const groups = [...new Set(selected.map((check) => check.group))]
  return { profile, checks: selected, groups }
}

export async function runGate(
  ports: GatePorts,
  options: GateRunOptions
): Promise<GateResult> {
  const startedAt = Date.now()
  const { profile, checks, groups } = selectGateChecks(options.config, {
    profile: options.profile,
    groups: options.groups,
    only: options.only
  })

  const outcomes: GateCheckOutcome[] = []
  let stopped = false

  for (const check of checks) {
    if (stopped || options.signal.aborted) {
      outcomes.push({
        id: check.id,
        ...(check.title !== undefined ? { title: check.title } : {}),
        kind: check.kind,
        group: check.group,
        required: check.required,
        status: 'not-run',
        exitCode: null,
        durationMs: 0,
        findings: []
      })
      continue
    }

    const label = check.title ? `${check.id} (${check.title})` : check.id
    ports.progress?.(`[gate:${check.id}] starting — ${label}`)
    const checkStarted = Date.now()

    if (check.kind === 'builtin') {
      const res = await ports.runBuiltin(
        options.root,
        check.builtin,
        check.options,
        options.signal,
        options.changedFiles ? { changedFiles: options.changedFiles } : undefined
      )
      const durationMs = Date.now() - checkStarted
      const status = res.ok ? 'passed' : 'failed'
      outcomes.push({
        id: check.id,
        ...(check.title !== undefined ? { title: check.title } : {}),
        kind: 'builtin',
        group: check.group,
        required: check.required,
        status,
        exitCode: res.exitCode,
        durationMs,
        ...(res.summary !== undefined ? { summary: res.summary } : {}),
        findings: res.findings ?? []
      })
      ports.progress?.(`[gate:${check.id}] ${status} (${durationMs}ms)`)
      if (status === 'failed' && (options.failFast || check.stopOnFail)) {
        stopped = true
      }
    } else {
      const res = await ports.runCommand(options.root, check.command, {
        ...(check.cwd !== undefined ? { cwd: check.cwd } : {}),
        ...(check.env !== undefined ? { env: check.env } : {}),
        signal: options.signal
      })
      const durationMs = Date.now() - checkStarted
      const passed = res.exitCode === 0
      const status = passed ? 'passed' : 'failed'
      const summary = passed
        ? undefined
        : (res.stderr.trim() || res.stdout.trim()).split(/\r?\n/).slice(-5).join('\n') ||
          `Command exited with code ${res.exitCode ?? 'unknown'}`
      outcomes.push({
        id: check.id,
        ...(check.title !== undefined ? { title: check.title } : {}),
        kind: 'command',
        group: check.group,
        required: check.required,
        status,
        exitCode: res.exitCode,
        durationMs,
        ...(summary !== undefined ? { summary } : {}),
        findings: []
      })
      ports.progress?.(`[gate:${check.id}] ${status} (${durationMs}ms)`)
      if (status === 'failed' && (options.failFast || check.stopOnFail)) {
        stopped = true
      }
    }
  }

  let passed = 0
  let failed = 0
  let skipped = 0
  let notRun = 0
  for (const item of outcomes) {
    if (item.status === 'passed') passed++
    else if (item.status === 'failed') failed++
    else if (item.status === 'skipped') skipped++
    else notRun++
  }

  const requiredFailed = outcomes.some(
    (item) => item.required && (item.status === 'failed' || item.status === 'not-run')
  )

  return {
    schemaVersion: 1,
    profile,
    groups,
    ok: !requiredFailed && !options.signal.aborted,
    durationMs: Date.now() - startedAt,
    checks: outcomes,
    totals: {
      total: outcomes.length,
      passed,
      failed,
      skipped,
      notRun
    }
  }
}

export function formatGateSummary(result: GateResult): string {
  const lines = [
    `Gate profile=${result.profile} status=${result.ok ? 'PASSED' : 'FAILED'} (${result.durationMs}ms)`
  ]
  for (const check of result.checks) {
    const req = check.required ? '' : ' [optional]'
    lines.push(
      `  - ${check.id} [${check.group}]${req}: ${check.status} (${check.durationMs}ms)`
    )
    if (check.status === 'failed' && check.summary) {
      lines.push(`      ${check.summary.replace(/\n/g, '\n      ')}`)
    }
  }
  lines.push(
    `Totals: ${result.totals.passed} passed, ${result.totals.failed} failed, ${result.totals.skipped} skipped, ${result.totals.notRun} not-run.`
  )
  return lines.join('\n')
}
