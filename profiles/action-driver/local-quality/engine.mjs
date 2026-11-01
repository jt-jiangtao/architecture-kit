/** Pure result policy; process, files, snapshots and clock are supplied by the CLI. */
export function classify(check, run) {
  const error = (notes) => ({ execution: 'error', verdict: 'unknown', findings: [], notes })
  if (run.error || run.signal || !Number.isInteger(run.code))
    return error(run.error || run.signal || 'process did not exit')
  if ((run.code > 1 && check.parser !== 'dependency-cruiser') || run.code < 0)
    return error(`tool exit ${run.code}`)
  if (
    /ERR_PNPM_(?:TASK_CYCLE|VERIFY_DEPS_BEFORE_RUN|NO_IMPORTER_MANIFEST_FOUND)/.test(
      run.stderr + run.stdout
    )
  )
    return error('package manager could not execute the check; see log')
  let findings = []
  try {
    if (check.parser === 'dependency-cruiser') {
      const data = JSON.parse(run.stdout)
      if (!Array.isArray(data.summary?.violations) || !Number.isInteger(data.summary.error))
        throw new Error('invalid dependency-cruiser report')
      if (run.code !== 0 && run.code !== Math.min(data.summary.error, 255))
        throw new Error('dependency-cruiser exit/report mismatch')
      findings = data.summary.violations.map((v) => `${v.from}:${v.to}:${v.rule.name}`)
    } else if (check.parser === 'knip') {
      const data = JSON.parse(run.stdout)
      if (!Array.isArray(data.issues) || (data.files !== undefined && !Array.isArray(data.files)))
        throw new Error('invalid Knip report')
      findings = [
        ...(data.files || []).map((file) => `unused-file:${file}`),
        ...data.issues.flatMap((issue) =>
          Object.entries(issue)
            .filter(([key]) => !['file', 'owners'].includes(key))
            .flatMap(([kind, values]) =>
              Array.isArray(values)
                ? values.map(
                    (value) =>
                      `${issue.file}:${kind}:${typeof value === 'string' ? value : value.name || JSON.stringify(value)}`
                  )
                : []
            )
        )
      ]
    } else if (check.parser === 'eslint') {
      const data = JSON.parse(run.stdout)
      if (!Array.isArray(data)) throw new Error('invalid ESLint report')
      findings = data.flatMap((file) =>
        file.messages.map((m) => `${file.filePath}:${m.ruleId}:${m.line}:${m.message}`)
      )
    } else if (check.parser === 'jscpd') {
      const data = JSON.parse(run.report ?? run.stdout)
      if (!Array.isArray(data.duplicates)) throw new Error('invalid jscpd report')
      findings = data.duplicates.map((d) => JSON.stringify(d))
    } else if (check.parser === 'gitleaks') {
      const data = JSON.parse(run.report)
      if (!Array.isArray(data)) throw new Error('invalid Gitleaks report')
      findings = data.map((d) => `${d.RuleID}:${d.File}:${d.StartLine}:${d.Fingerprint || ''}`)
    } else if (check.parser === 'audit') {
      const data = JSON.parse(run.report)
      if (!data.counts || typeof data.counts !== 'object') throw new Error('invalid audit report')
      findings = Object.entries(data.counts)
        .filter(([key, n]) => !['keep-proven', 'dynamic-load-risk'].includes(key) && n > 0)
        .map(([key, n]) => `${key}:${n}`)
    } else if (check.parser === 'pnpm-audit') {
      const data = JSON.parse(run.stdout)
      if (data.error || !data.metadata?.vulnerabilities)
        throw new Error('invalid vulnerability response')
      findings = Object.entries(data.advisories || data.vulnerabilities || {}).map(
        ([id, entry]) => `${id}:${entry.module_name || entry.name || ''}`
      )
      if (!findings.length && Object.values(data.metadata.vulnerabilities).some((n) => n > 0))
        findings = ['vulnerabilities:see-report']
    } else if (check.parser === 'osv') {
      const data = JSON.parse(run.stdout)
      if (!Array.isArray(data.results)) throw new Error('invalid OSV report')
      findings = data.results.flatMap((r) =>
        (r.packages || []).flatMap((p) =>
          (p.vulnerabilities || []).map((v) => `${p.package?.name}:${v.id}`)
        )
      )
    } else if (run.code === 1) {
      findings = [`${check.id}:exit-1 (see log)`]
    }
  } catch (e) {
    return error(`missing/invalid evidence: ${e.message}`)
  }
  if (run.code === 1 && findings.length === 0) return error('non-zero result without findings')
  return {
    execution: 'success',
    findingsComparable: check.parser !== 'exit',
    verdict: findings.length
      ? ['jscpd', 'audit'].includes(check.parser)
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

export function compareBaseline(current, previous) {
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

export async function runChecks(plan, ports, baseline) {
  const before = await ports.snapshot()
  const started = ports.now()
  const results = []
  for (const check of plan) {
    const blocked = check.dependsOn?.some(
      (id) => !results.some((r) => r.id === id && r.execution === 'success' && r.verdict === 'pass')
    )
    const start = ports.now()
    let run = { code: null, version: null }
    let assessment
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
        assessment = classify(check, run)
      } catch (e) {
        assessment = { execution: 'error', verdict: 'unknown', findings: [], notes: e.message }
      }
    }
    const row = {
      ...check,
      ...assessment,
      toolVersion: run.version,
      exitCode: run.code,
      started: start,
      ended: ports.now(),
      configDigest: before.configDigest
    }
    if (baseline)
      row.baseline = compareBaseline(
        row,
        baseline.results?.find((r) => r.id === check.id)
      )
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

export function renderSummary(report) {
  const cell = (v) =>
    String(v ?? '')
      .replaceAll('|', '\\|')
      .replaceAll('\n', ' ')
  return `# 本地质量检查\n\n时间：${new Date(report.started).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })} → ${new Date(report.ended).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })}（Asia/Shanghai）\n\nHEAD：${report.snapshot.head || 'unknown'}；输入指纹：${report.snapshot.digest}；证据有效：${report.evidenceValid}；退出码：${report.exitCode}\n\n| 检查 | 执行 | 结论 | 必需 | 范围 | 说明 |\n|---|---|---|---|---|---|\n${report.results.map((r) => `| ${r.id} | ${r.execution} | ${r.verdict} | ${r.required} | ${cell(r.scope?.join(', '))} | ${cell(r.notes)} |`).join('\n')}\n\n静态检查不替代发布、动态入口和真实宿主行为验收。review 需要复核；unknown 为证据缺口，不是通过。\n\n机器结果、版本、命令、基线差异见 results.json；每项原始证据见对应日志/JSON。基线比较不豁免问题。\n`
}
