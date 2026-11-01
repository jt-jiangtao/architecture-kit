import type { CleanupResult } from './check.js'

export function renderReport(result: CleanupResult): string {
  const lines = [
    '# Cleanup check',
    '',
    `Execution **${result.status}** · ${result.findings.length} findings · ${result.coverageGaps.length} coverage gaps`,
    '',
    '## Findings',
    ''
  ]
  for (const f of result.findings) {
    lines.push(
      `- **${f.level}** ${f.target}${f.symbol ? ' (' + f.symbol + ')' : ''} — ${f.rule}. ${f.reason}.`
    )
  }
  if (!result.findings.length) lines.push('No findings in the report scope.')
  if (result.audit)
    lines.push(
      '',
      'Full-project audit: ' +
        result.audit.candidates.length +
        ' ledger candidates. [Agent tasks](tasks.md) · [Ledger](' +
        result.audit.ledger +
        ')',
      ''
    )
  lines.push('', '## Execution evidence', '')
  for (const e of result.evidence)
    lines.push(
      `- [${e.file}](${e.file}) — ${e.status}${e.reason ? ' (' + e.reason + ')' : ''}`
    )
  const recorded = new Set(result.evidence.map((e) => e.file))
  for (const gap of result.coverageGaps) {
    if (!gap.file) lines.push('- ' + gap.reason)
    else if (!recorded.has(gap.file))
      lines.push(`- [${gap.file}](${gap.file}) — ${gap.reason}`)
  }
  return lines.join('\n') + '\n'
}

/** The checklist is a view of the same run, never authorization to edit a target. */
export function renderTasks(
  result: CleanupResult,
  runId: string,
  roundId: string
) {
  const lines = [
    '# Cleanup 排查任务',
    '',
    '任务 ' + runId + ' / ' + roundId + ' · ' + result.status,
    '',
    '[机器结果](result.json) · [检查摘要](report.md)',
    ''
  ]
  if (result.status !== 'complete')
    lines.push(
      '**证据不完整。先解决下列阻断并重跑 check，本轮不能用于删除。**',
      ''
    )
  for (const gap of result.coverageGaps) {
    lines.push(
      '- [ ] 排查 ' +
        gap.reason +
        (gap.file ? '，打开 [' + gap.file + '](' + gap.file + ')' : '') +
        '。'
    )
    if (gap.file?.startsWith('hooks/'))
      lines.push(
        '  在该目录查看实际命令、退出码及非空的 stdout.log / stderr.log，再从项目根复现。'
      )
  }
  lines.push('', '## 范围内的工具发现', '')
  for (const task of result.tasks) {
    const finding = result.findings.find((row) => row.id === task.finding)!
    lines.push(
      '- [ ] **' +
        task.level +
        '** `' +
        task.target +
        '` ' +
        finding.rule +
        ' ' +
        finding.symbol,
      '  - 任务 ID：`' +
        task.id +
        '`。允许操作：' +
        task.allowedActions.join(', ') +
        '。',
      '  - 核验：' +
        task.verify.join('；') +
        '。阻断：' +
        (task.blockers.join(', ') || '无额外标记') +
        '。'
    )
    for (const ref of task.evidence)
      lines.push(
        '  - [' + ref.file + '](' + ref.file + ') 中查找 `' + ref.id + '`。'
      )
  }
  if (result.audit) {
    lines.push(
      '',
      '## 全项目专项审计（' + result.audit.candidates.length + ' 项）',
      '',
      '候选 ID 只在本轮有效。[完整 ledger](' +
        result.audit.ledger +
        ') 含每项的 evidence、risk、allowedChanges 和 review。按目标路径或 ID 查找。',
      ''
    )
    lines.push(
      '在 output 目录读取候选：\`jq \'.candidates[] | select(.id == "C-001")\' ' +
        result.audit.ledger +
        '\`。先看 targets、evidence、risk，再核对 allowedChanges。',
      ''
    )
    for (const c of result.audit.candidates)
      lines.push(
        '- [ ] **' +
          c.id +
          ' · L' +
          c.level +
          '** ' +
          c.kind +
          ' · ' +
          c.targets
            .map((t) => '`' + t.file + (t.symbol ? '#' + t.symbol : '') + '`')
            .join(', ') +
          ' · ' +
          c.state +
          (c.knipModes?.length ? ' · Knip ' + c.knipModes.join(' / ') : '') +
          (c.knipModes?.length === 1 && c.knipModes[0] === 'production'
            ? '。仅生产模式报告，请核对测试和动态消费者。' : '')
      )
    lines.push(
      '',
      '复核后使用 `architecture-kit cleanup verify --run-id ' +
        runId +
        ' --from ' +
        roundId +
        ' --candidate C-NNN` 验证指定候选。'
    )
  }
  lines.push(
    '',
    '重新收集证据：`architecture-kit cleanup check --run-id ' + runId + '`。'
  )
  return lines.join('\n') + '\n'
}
