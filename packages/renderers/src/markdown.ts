import { compareStrings } from '@architecture-kit/core-ir'
import type {
  ArchitectureGraph,
  ArchitectureIndexResult,
  CleanupResult,
  FactSnapshot,
  OptimizeResultTask
} from '@architecture-kit/core-ir'

export function renderArchitectureIndex(
  facts: FactSnapshot,
  outputs: readonly string[]
): { result: ArchitectureIndexResult; report: string } {
  const entries = facts.entries.filter((row) => row.kind === 'export')
  const modules = outputs.includes('module-index')
    ? entries.map((row) => ({
        package: row.package,
        subpath: row.subpath,
        conditions: row.conditions,
        target: row.target,
        sourceRef: row.sourceRef,
        unresolved: row.source === null
      }))
    : []
  const sources = outputs.includes('source-index')
    ? entries
        .flatMap((row) =>
          row.source
            ? [
                {
                  file: row.source,
                  package: row.package,
                  subpath: row.subpath,
                  conditions: row.conditions
                }
              ]
            : []
        )
        .sort((a, b) => compareStrings(a.file, b.file))
    : []
  const result: ArchitectureIndexResult = { schemaVersion: 1, modules, sources }
  const lines = ['# Architecture index', '']
  if (outputs.includes('module-index')) {
    lines.push(
      '## Modules',
      '',
      ...result.modules.map(
        (row) =>
          `- \`${row.package}\` \`${row.subpath}\` [${row.conditions.join('/')}] → \`${row.target}\`${row.unresolved ? ' (unresolved)' : ''}`
      ),
      ''
    )
  }
  if (outputs.includes('source-index')) {
    lines.push(
      '## Sources',
      '',
      ...result.sources.map(
        (row) =>
          `- \`${row.file}\` → \`${row.package}\` \`${row.subpath}\` [${row.conditions.join('/')}]`
      ),
      ''
    )
  }
  return { result, report: lines.join('\n') }
}

export function renderModuleMarkdown(graph: ArchitectureGraph, preview: boolean): string {
  const link = (item: { name: string; sourceUrl: string }) =>
    '- [' + item.name + '](' + (preview ? 'site/' : '') + item.sourceUrl + ')'
  return (
    [
      '# ' + graph.component.title,
      graph.component.description,
      graph.apis.map(link).join('\n'),
      graph.decisions.map((d) => '[' + d.title + '](decision.md)').join('\n')
    ].join('\n\n') + '\n'
  )
}

export function renderDecisionMarkdown(graph: ArchitectureGraph, preview: boolean): string {
  const link = (item: { name: string; sourceUrl: string }) =>
    '- [' + item.name + '](' + (preview ? 'site/' : '') + item.sourceUrl + ')'
  return (
    graph.decisions
      .map((d) =>
        [
          '# ' + d.title,
          d.body,
          graph.apis
            .filter((a) => d.affectedApis.includes(a.id))
            .map(link)
            .join('\n'),
          d.tests.map(link).join('\n')
        ].join('\n\n')
      )
      .join('\n\n') + '\n'
  )
}

export function renderLlmsTxt(graph: ArchitectureGraph): { llmsTxt: string; llmsFullTxt: string } {
  const modules = [...(graph.modules ?? [graph])].sort((a, b) =>
    compareStrings(a.package, b.package)
  )
  const shortLines = [
    '# Architecture Kit Index',
    '',
    `> Mode: ${graph.mode} · Revision: ${graph.revision}`,
    '',
    '## Modules',
    ''
  ]
  const fullLines = [
    '# Architecture Kit Full Reference',
    '',
    `> Mode: ${graph.mode} · Revision: ${graph.revision}`,
    ''
  ]

  for (const mod of modules) {
    shortLines.push(
      `- [${mod.component.title}](/modules/${mod.component.id}/index.html) (\`${mod.package}\`): ${mod.component.description.replace(/\s+/g, ' ').trim()}`
    )
    fullLines.push(`## ${mod.component.title} (\`${mod.package}\`)`, '')
    if (mod.component.description.trim()) {
      fullLines.push(mod.component.description.trim(), '')
    }
    if (mod.apis.length) {
      fullLines.push('### Public APIs', '')
      for (const api of [...mod.apis].sort((a, b) => compareStrings(a.id, b.id))) {
        fullLines.push(`- \`${api.id}\` (${api.file}:${api.line})`)
      }
      fullLines.push('')
    }
    if (mod.decisions.length) {
      fullLines.push('### Decisions', '')
      for (const dec of [...mod.decisions].sort((a, b) => compareStrings(a.id, b.id))) {
        fullLines.push(`- **${dec.id}**: ${dec.title}`, `  ${dec.body.replace(/\s+/g, ' ').trim()}`)
      }
      fullLines.push('')
    }
  }

  if (graph.relations?.length) {
    fullLines.push('## Component Relations', '')
    for (const rel of [...graph.relations].sort(
      (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to)
    )) {
      fullLines.push(`- \`${rel.from}\` -> \`${rel.to}\`${rel.label ? `: ${rel.label}` : ''}`)
    }
    fullLines.push('')
  }

  return {
    llmsTxt: shortLines.join('\n') + '\n',
    llmsFullTxt: fullLines.join('\n')
  }
}

export function renderCleanupReport(result: CleanupResult): string {
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
    lines.push(`- [${e.file}](${e.file}) — ${e.status}${e.reason ? ' (' + e.reason + ')' : ''}`)
  const recorded = new Set(result.evidence.map((e) => e.file))
  for (const gap of result.coverageGaps) {
    if (!gap.file) lines.push('- ' + gap.reason)
    else if (!recorded.has(gap.file)) lines.push(`- [${gap.file}](${gap.file}) — ${gap.reason}`)
  }
  return lines.join('\n') + '\n'
}

/** The checklist is a view of the same run, never authorization to edit a target. */
export function renderCleanupTasks(result: CleanupResult, runId: string, roundId: string): string {
  const lines = [
    '# Cleanup 排查任务',
    '',
    '任务 ' + runId + ' / ' + roundId + ' · ' + result.status,
    '',
    '[机器结果](result.json) · [检查摘要](report.md)',
    ''
  ]
  if (result.status !== 'complete')
    lines.push('**证据不完整。先解决下列阻断并重跑 check，本轮不能用于删除。**', '')
  for (const gap of result.coverageGaps) {
    lines.push(
      '- [ ] 排查 ' + gap.reason + (gap.file ? '，打开 [' + gap.file + '](' + gap.file + ')' : '') + '。'
    )
    if (gap.file?.startsWith('hooks/'))
      lines.push('  在该目录查看实际命令、退出码及非空的 stdout.log / stderr.log，再从项目根复现。')
  }
  lines.push('', '## 范围内的工具发现', '')
  for (const task of result.tasks) {
    const finding = result.findings.find((row) => row.id === task.finding)!
    lines.push(
      '- [ ] **' + task.level + '** `' + task.target + '` ' + finding.rule + ' ' + finding.symbol,
      '  - 任务 ID：`' + task.id + '`。允许操作：' + task.allowedActions.join(', ') + '。',
      '  - 核验：' + task.verify.join('；') + '。阻断：' + (task.blockers.join(', ') || '无额外标记') + '。'
    )
    for (const ref of task.evidence)
      lines.push('  - [' + ref.file + '](' + ref.file + ') 中查找 `' + ref.id + '`。')
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
      "在 output 目录读取候选：`jq '.candidates[] | select(.id == \"C-001\")' " +
        result.audit.ledger +
        '`。先看 targets、evidence、risk，再核对 allowedChanges。',
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
          c.targets.map((t) => '`' + t.file + (t.symbol ? '#' + t.symbol : '') + '`').join(', ') +
          ' · ' +
          c.state +
          (c.knipModes?.length ? ' · Knip ' + c.knipModes.join(' / ') : '') +
          (c.knipModes?.length === 1 && c.knipModes[0] === 'production'
            ? '。仅生产模式报告，请核对测试和动态消费者。'
            : '')
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
  lines.push('', '重新收集证据：`architecture-kit cleanup check --run-id ' + runId + '`。')
  return lines.join('\n') + '\n'
}

export function renderOptimizeTasks(
  rows: OptimizeResultTask[],
  runId: string,
  roundId: string,
  cleanupFrom?: string
): string {
  return [
    '# 优化任务',
    '',
    ...rows.flatMap((r) => [
      '## ' + r.id + ' · ' + r.title,
      '',
      '- 目标：`' + r.target + '`',
      '- 假设：' + r.hypothesis,
      '- 状态：' + r.verdict + '。' + r.reason,
      '- 证据：' + r.evidence.map((e) => '[' + e + '](' + e + ')').join('、'),
      '- 复验：`architecture-kit optimize check --run-id ' +
        runId +
        ' --from ' +
        roundId +
        ' --task ' +
        r.id +
        (cleanupFrom && r.id.startsWith('clone-') ? ' --cleanup-from ' + cleanupFrom : '') +
        '`',
      ''
    ])
  ].join('\n')
}
