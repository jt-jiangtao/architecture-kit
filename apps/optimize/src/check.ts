import type { OptimizeTask } from '../../../packages/config/src/index.js'

export type Measurement = { workload: string; samples: number[] }
export type ResultTask = {
  id: string
  title: string
  target: string
  hypothesis: string
  kind: string
  verdict: string
  dispersion: number
  sampleCount: number
  key: string
  unit: string | null
  value: number | null
  delta: number | null
  reason: string
  evidence: string[]
}
type Ports = {
  key: (task: OptimizeTask) => Promise<string>
  run: (
    id: string,
    stage: 'measure' | 'behavior',
    argv: string[]
  ) => Promise<number | null>
  measurement: (id: string) => Promise<unknown>
  progress: (line: string) => void
  signal: AbortSignal
}
function parse(raw: unknown): Measurement {
  const m = raw as Measurement | null
  if (
    !m ||
    typeof m.workload !== 'string' ||
    !m.workload.trim() ||
    !Array.isArray(m.samples) ||
    !m.samples.length ||
    m.samples.some((x) => typeof x !== 'number' || !Number.isFinite(x) || x < 0)
  )
    throw new Error('Expected a named workload and finite nonnegative samples')
  return m
}
function median(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[mid]!
    : sorted[mid - 1]! / 2 + sorted[mid]! / 2
}
export async function optimize(
  tasks: OptimizeTask[],
  previous: ResultTask[] | null,
  ports: Ports
) {
  const rows: ResultTask[] = []
  for (const task of tasks) {
    ports.signal.throwIfAborted()
    const row: ResultTask = {
      id: task.id,
      title: task.title,
      target: task.target,
      hypothesis: task.hypothesis,
      kind: task.kind,
      verdict: 'incomplete',
      dispersion: 0,
      sampleCount: 0,
      key: '',
      unit: task.unit ?? null,
      value: null,
      delta: null,
      reason: '',
      evidence: []
    }
    rows.push(row)
    ports.progress('开始 ' + task.id + ' · ' + task.title)
    try {
      const key = await ports.key(task)
      if (task.check) {
        row.evidence.push('evidence/' + task.id + '/behavior.json')
        if ((await ports.run(task.id, 'behavior', task.check)) !== 0)
          throw new Error('行为或预算检查未通过，查看 behavior 日志')
      }
      if (task.kind !== 'metric') {
        row.key = key
        row.verdict = task.kind === 'review' ? 'needs-review' : 'passed'
        row.reason =
          task.kind === 'review'
            ? '核对调用方与行为契约，记录合并或保留的依据'
            : '预算或行为检查通过'
      } else {
        row.evidence.push('evidence/' + task.id + '/measure.json')
        if ((await ports.run(task.id, 'measure', task.measure!)) !== 0)
          throw new Error('测量命令失败，查看 measure 日志')
        const m = parse(await ports.measurement(task.id))
        row.evidence.push('evidence/' + task.id + '/samples.json')
        row.value = median(m.samples)
        const center = row.value
        row.sampleCount = m.samples.length
        row.dispersion = median(m.samples.map((x) => Math.abs(x - center)))
        row.key = JSON.stringify([key, m.workload, m.samples.length])
        const base = previous?.find((x) => x.id === task.id)
        if (!previous) {
          row.verdict = 'baseline'
          row.reason = '已记录中位数及原始样本'
        } else if (
          !base ||
          base.key !== row.key ||
          base.value === null ||
          base.verdict === 'incomplete'
        ) {
          row.verdict = 'incomparable'
          row.reason = '基线缺少同任务、环境、负载或样本口径'
        } else {
          row.delta = row.value - base.value
          const magnitude = Math.abs(row.delta),
            threshold = Math.max(
              base.value * task.tolerance!,
              3 * ((base.dispersion ?? 0) + row.dispersion)
            )
          row.verdict =
            magnitude <= threshold
              ? 'unchanged'
              : (task.direction === 'lower' ? row.delta < 0 : row.delta > 0)
                ? 'improved'
                : 'regressed'
          row.reason =
            '基线 ' +
            base.value +
            ' → ' +
            row.value +
            ' ' +
            task.unit +
            '；绝对差 ' +
            row.delta
        }
      }
    } catch (e) {
      row.verdict = 'incomplete'
      row.reason = e instanceof Error ? e.message : String(e)
    }
    ports.progress(task.id + ' · ' + row.verdict)
  }
  return rows
}
export function renderOptimize(
  rows: ResultTask[],
  runId: string,
  roundId: string,
  cleanupFrom?: string
) {
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
        (cleanupFrom && r.id.startsWith('clone-')
          ? ' --cleanup-from ' + cleanupFrom
          : '') +
        '`',
      ''
    ])
  ].join('\n')
}
