import path from 'node:path'
import type { CommandResult } from '../audit/snapshot.js'

export interface QualityCheck {
  id: string
  command?: string[] | undefined
  parser?: string | undefined
  minimumPackages?: Record<string, number> | undefined
  scope?: string[] | undefined
  required?: boolean | undefined
  tool?: string | undefined
  dependsOn?: string[] | undefined
  pending?: string | undefined
  cwd?: string | undefined
  report?: string | undefined
}

export interface QualityAssessment {
  execution: 'success' | 'error' | 'skipped'
  verdict: 'pass' | 'findings' | 'review' | 'unknown'
  findingsComparable?: boolean | undefined
  findings: string[]
  notes: string
}

export interface QualityCheckResult extends QualityCheck, QualityAssessment {
  toolVersion: string | null
  exitCode: number | null
  started: string
  ended: string
  configDigest: string | undefined
  baseline?: BaselineComparison | undefined
}

export interface BaselineComparison {
  comparable: boolean
  added?: string[] | undefined
  existing?: string[] | undefined
  resolved?: string[] | undefined
}

export interface QualityReport {
  schema: number
  started: string
  ended: string
  snapshot: { head?: string | undefined; digest: string; configDigest?: string | undefined }
  finalSnapshot: { digest: string }
  evidenceValid: boolean
  results: QualityCheckResult[]
  exitCode: number
  mode?: string | undefined
  partial?: boolean | undefined
  coverageNotes?: string[] | undefined
}

export interface QualityPorts {
  snapshot: () =>
    | Promise<{ head?: string | undefined; digest: string; configDigest?: string | undefined }>
    | { head?: string | undefined; digest: string; configDigest?: string | undefined }
  now: () => string
  execute: (check: QualityCheck) => Promise<CommandResult> | CommandResult
  save: (check: QualityCheck, run: CommandResult, row: QualityCheckResult) => Promise<void> | void
}

/** Pure result policy; process, files, snapshots and clock are supplied by ports. */
export function classify(
  check: QualityCheck,
  run: Partial<CommandResult>,
  repo = process.cwd()
): QualityAssessment {
  const error = (notes: string): QualityAssessment => ({
    execution: 'error',
    verdict: 'unknown',
    findings: [],
    notes
  })
  if (run.error || run.signal || !Number.isInteger(run.code)) {
    return error(run.error || run.signal || 'process did not exit')
  }
  const code = run.code!
  if ((code > 1 && check.parser !== 'dependency-cruiser') || code < 0) {
    return error(`tool exit ${code}`)
  }
  if (
    /ERR_PNPM_(?:TASK_CYCLE|VERIFY_DEPS_BEFORE_RUN|NO_IMPORTER_MANIFEST_FOUND)/.test(
      (run.stderr || '') + (run.stdout || '')
    )
  ) {
    return error('package manager could not execute the check; see log')
  }
  let findings: string[] = []
  try {
    if (check.parser === 'dependency-cruiser') {
      const data = JSON.parse(run.stdout || '') as {
        summary?: {
          violations?: Array<{ from: string; to: string; rule: { name: string } }>
          error?: number
          ruleCoverage?: Record<string, number>
        }
      }
      if (!Array.isArray(data.summary?.violations) || !Number.isInteger(data.summary.error)) {
        throw new Error('invalid dependency-cruiser report')
      }
      const empty = Object.entries(data.summary.ruleCoverage ?? {}).filter(
        ([, count]) => !Number.isInteger(count) || count <= 0
      )
      if (data.summary.ruleCoverage && !Object.keys(data.summary.ruleCoverage).length)
        return error('No boundary rules in report')
      if (empty.length)
        return error('No source coverage: ' + empty.map(([name]) => name).join(', '))
      if (code !== 0 && code !== Math.min(data.summary.error!, 255)) {
        throw new Error('dependency-cruiser exit/report mismatch')
      }
      findings = data.summary.violations.map((v) => `${v.from}:${v.to}:${v.rule.name}`)
    } else if (check.parser === 'knip') {
      const data = JSON.parse(run.stdout || '') as {
        files?: unknown
        issues?: Array<Record<string, unknown>>
      }
      if (!Array.isArray(data.issues) || (data.files !== undefined && !Array.isArray(data.files))) {
        throw new Error('invalid Knip report')
      }
      findings = [
        ...((data.files as unknown[]) || []).map((file) => {
          if (typeof file !== 'string' || !file) throw new Error('invalid Knip file')
          return 'unused-file:' + file
        }),
        ...data.issues.flatMap((issue) =>
          Object.entries(issue)
            .filter(([key]) => !['file', 'owners'].includes(key))
            .flatMap(([kind, values]) =>
              Array.isArray(values)
                ? values.map((value: unknown) => {
                    const obj =
                      value && typeof value === 'object' ? (value as { name?: string }) : null
                    const name = typeof value === 'string' ? value : obj?.name
                    if (kind === 'files') {
                      if (!name || name !== issue.file)
                        throw new Error('invalid Knip file observation')
                      return 'unused-file:' + name
                    }
                    return `${String(issue.file)}:${kind}:${name || JSON.stringify(value)}`
                  })
                : []
            )
        )
      ]
    } else if (check.parser === 'eslint') {
      const data = JSON.parse(run.stdout || '') as Array<{
        filePath: string
        messages: Array<{ ruleId: string; line: number; message: string }>
      }>
      if (!Array.isArray(data)) throw new Error('invalid ESLint report')
      findings = data.flatMap((file) =>
        file.messages.map((m) => `${file.filePath}:${m.ruleId}:${m.line}:${m.message}`)
      )
    } else if (check.parser === 'jscpd') {
      const data = JSON.parse(run.report ?? run.stdout ?? '') as { duplicates?: unknown[] }
      if (!Array.isArray(data.duplicates)) throw new Error('invalid jscpd report')
      findings = data.duplicates.map((d) => JSON.stringify(d))
    } else if (check.parser === 'gitleaks') {
      const data = JSON.parse(run.report ?? '') as Array<{
        RuleID: string
        File: string
        StartLine: number
        Fingerprint?: string
      }>
      if (!Array.isArray(data)) throw new Error('invalid Gitleaks report')
      findings = data.map((d) => `${d.RuleID}:${d.File}:${d.StartLine}:${d.Fingerprint || ''}`)
    } else if (check.parser === 'audit') {
      const data = JSON.parse(run.report ?? '') as { counts?: Record<string, number> }
      if (!data.counts || typeof data.counts !== 'object') throw new Error('invalid audit report')
      findings = Object.entries(data.counts)
        .filter(([key, n]) => !['keep-proven', 'dynamic-load-risk'].includes(key) && n > 0)
        .map(([key, n]) => `${key}:${n}`)
    } else if (check.parser === 'pnpm-audit') {
      const data = JSON.parse(run.stdout || '') as {
        error?: unknown
        metadata?: { vulnerabilities?: Record<string, number> }
        advisories?: Record<string, { module_name?: string; name?: string }>
        vulnerabilities?: Record<string, { module_name?: string; name?: string }>
      }
      if (data.error || !data.metadata?.vulnerabilities) {
        throw new Error('invalid vulnerability response')
      }
      findings = Object.entries(data.advisories || data.vulnerabilities || {}).map(
        ([id, entry]) => `${id}:${entry.module_name || entry.name || ''}`
      )
      if (!findings.length && Object.values(data.metadata.vulnerabilities).some((n) => n > 0)) {
        findings = ['vulnerabilities:see-report']
      }
    } else if (check.parser === 'osv') {
      const data = JSON.parse(run.stdout || '') as {
        results?: Array<{
          source?: { path?: string }
          packages?: Array<{
            package?: { name?: string }
            vulnerabilities?: Array<{ id: string }>
          }>
        }>
      }
      if (!Array.isArray(data.results)) throw new Error('invalid OSV report')
      if (check.minimumPackages) {
        const counts = new Map<string, number>()
        for (const row of data.results) {
          if (!row.source?.path || !Array.isArray(row.packages))
            return error('Missing OSV source or packages')
          const source = path
            .relative(repo, path.resolve(repo, row.source.path))
            .split(path.sep)
            .join('/')
          counts.set(source, (counts.get(source) ?? 0) + row.packages.length)
        }
        for (const [file, minimum] of Object.entries(check.minimumPackages)) {
          const actual = counts.get(file) ?? 0
          if (actual < minimum)
            return error(
              `Incomplete OSV coverage: ${file} reported ${actual} packages, expected at least ${minimum}`
            )
        }
      }
      findings = data.results.flatMap((r) =>
        (r.packages || []).flatMap((p) =>
          (p.vulnerabilities || []).map((v) => `${p.package?.name}:${v.id}`)
        )
      )
    } else if (code === 1) {
      findings = [`${check.id}:exit-1 (see log)`]
    }
  } catch (e) {
    return error(`missing/invalid evidence: ${(e as Error).message}`)
  }
  if (code === 1 && findings.length === 0) return error('non-zero result without findings')
  return {
    execution: 'success',
    findingsComparable: check.parser !== 'exit',
    verdict: findings.length
      ? ['jscpd', 'audit'].includes(check.parser ?? '')
        ? 'review'
        : 'findings'
      : 'pass',
    findings,
    notes: findings.length
      ? check.parser === 'exit'
        ? 'check reported issues; see raw log (count unavailable)'
        : `${findings.length} findings`
      : 'no findings within declared scope'
  }
}

export function compareBaseline(
  current: {
    scope?: string[] | undefined
    toolVersion?: string | null | undefined
    configDigest?: string | undefined
    findingsComparable?: boolean | undefined
    findings: string[]
  },
  previous:
    | {
        scope?: string[] | undefined
        toolVersion?: string | null | undefined
        configDigest?: string | undefined
        findings: string[]
      }
    | undefined
): BaselineComparison {
  if (
    !previous ||
    !current.toolVersion ||
    !current.configDigest ||
    current.findingsComparable === false ||
    JSON.stringify(current.scope) !== JSON.stringify(previous.scope) ||
    current.toolVersion !== previous.toolVersion ||
    current.configDigest !== previous.configDigest
  ) {
    return { comparable: false }
  }
  const old = new Set(previous.findings)
  const now = new Set(current.findings)
  return {
    comparable: true,
    added: [...now].filter((f) => !old.has(f)),
    existing: [...now].filter((f) => old.has(f)),
    resolved: [...old].filter((f) => !now.has(f))
  }
}

export async function runChecks(
  plan: QualityCheck[],
  ports: QualityPorts,
  baseline?: { results?: QualityCheckResult[] | undefined },
  repo = process.cwd()
): Promise<QualityReport> {
  const before = await ports.snapshot()
  const started = ports.now()
  const results: QualityCheckResult[] = []
  for (const check of plan) {
    const blocked = check.dependsOn?.some(
      (id) => !results.some((r) => r.id === id && r.execution === 'success' && r.verdict === 'pass')
    )
    const start = ports.now()
    let run: CommandResult = { code: null, stdout: '', stderr: '', signal: null, version: null }
    let assessment: QualityAssessment
    if (check.pending || blocked) {
      assessment = {
        execution: 'skipped',
        verdict: 'unknown',
        findings: [],
        notes: check.pending || 'prerequisite not satisfied'
      }
    } else {
      try {
        run = await ports.execute(check)
        assessment = classify(check, run, repo)
      } catch (e) {
        assessment = {
          execution: 'error',
          verdict: 'unknown',
          findings: [],
          notes: (e as Error).message
        }
      }
    }
    const row: QualityCheckResult = {
      ...check,
      ...assessment,
      toolVersion: run.version ?? null,
      exitCode: run.code,
      started: start,
      ended: ports.now(),
      configDigest: before.configDigest
    }
    if (baseline) {
      const prior = baseline.results?.find((r) => r.id === check.id)
      row.baseline = compareBaseline(row, prior)
    }
    results.push(row)
    await ports.save(check, run, row)
  }
  const after = await ports.snapshot()
  const evidenceValid = before.digest === after.digest
  const incomplete = !evidenceValid || results.some((r) => r.required && r.execution !== 'success')
  const failed = results.some((r) => r.required && r.verdict === 'findings')
  return {
    schema: 1,
    started,
    ended: ports.now(),
    snapshot: before,
    finalSnapshot: after,
    evidenceValid,
    results,
    exitCode: incomplete ? 2 : failed ? 1 : 0
  }
}

export function renderSummary(report: QualityReport): string {
  const cell = (v: unknown) =>
    String(v ?? '')
      .replaceAll('|', '\\|')
      .replaceAll('\n', ' ')
  return `# 本地质量检查\n\n时间：${new Date(report.started).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })} → ${new Date(report.ended).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}（Asia/Shanghai）\n\nHEAD：${report.snapshot.head || 'unknown'}；输入指纹：${report.snapshot.digest}；证据有效：${report.evidenceValid}；退出码：${report.exitCode}\n\n| 检查 | 执行 | 结论 | 必需 | 范围 | 说明 |\n|---|---|---|---|---|---|\n${report.results.map((r) => `| ${r.id} | ${r.execution} | ${r.verdict} | ${r.required} | ${cell(r.scope?.join(', '))} | ${cell(r.notes)} |`).join('\n')}\n\n静态检查不替代发布、动态入口和真实宿主行为验收。review 需要复核；unknown 为证据缺口，不是通过。\n\n机器结果、版本、命令、基线差异见 results.json；每项原始证据见对应日志/JSON。基线比较不豁免问题。\n`
}
