#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SUMMARY_FIELDS = [
  'timeToFirstTokenMs',
  'decodeTokensPerSecond',
  'streamBlockMs',
  'harnessOverheadMs'
]

export function loadRecords(paths) {
  const records = []
  for (const path of paths) {
    const text = readFileSync(path, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      records.push(JSON.parse(trimmed))
    }
  }
  return records
}

export function quantile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  const weight = index - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

export function linearSlope(points) {
  if (points.length < 2) return null
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (const point of points) {
    sumX += point.x
    sumY += point.y
    sumXY += point.x * point.y
    sumXX += point.x * point.x
  }
  const n = points.length
  const denominator = n * sumXX - sumX * sumX
  if (denominator === 0) return null
  return (n * sumXY - sumX * sumY) / denominator
}

export function summarize(records) {
  const distribution = (field) => {
    const values = []
    let excluded = 0
    for (const record of records) {
      const value = record[field]
      if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
      else excluded += 1
    }
    return {
      median: quantile(values, 0.5),
      p90: quantile(values, 0.9),
      excluded
    }
  }
  const decode = distribution('decodeTokensPerSecond')
  const slopePoints = records.flatMap((record) =>
    typeof record.decodeTokensPerSecond === 'number' && typeof record.turnIndex === 'number'
      ? [{ x: record.turnIndex, y: record.decodeTokensPerSecond }]
      : []
  )
  let cached = 0
  let input = 0
  let cacheExcluded = 0
  let harness = 0
  let turn = 0
  for (const record of records) {
    if (typeof record.cachedInputTokens === 'number' && typeof record.inputTokens === 'number') {
      cached += record.cachedInputTokens
      input += record.inputTokens
    } else cacheExcluded += 1
    if (typeof record.harnessOverheadMs === 'number') harness += record.harnessOverheadMs
    if (typeof record.turnMs === 'number') turn += record.turnMs
  }
  return {
    turnCount: records.length,
    timeToFirstTokenMs: distribution('timeToFirstTokenMs'),
    decodeTokensPerSecond: { ...decode, slopePerTurn: linearSlope(slopePoints) },
    streamBlockMs: distribution('streamBlockMs'),
    harnessOverheadMs: distribution('harnessOverheadMs'),
    cacheHitRate: { weighted: input === 0 ? null : cached / input, excluded: cacheExcluded },
    harnessRatio: turn === 0 ? null : harness / turn
  }
}

export function compare(baselineRecords, candidateRecords) {
  const baseline = { summary: summarize(baselineRecords), turns: baselineRecords }
  const candidate = { summary: summarize(candidateRecords), turns: candidateRecords }
  const delta = {}
  for (const field of [...SUMMARY_FIELDS, 'cacheHitRate', 'harnessRatio']) {
    delta[field] = fieldDelta(baseline.summary[field], candidate.summary[field])
  }
  return { baseline, candidate, delta }
}

function fieldDelta(baseline, candidate) {
  if (baseline && typeof baseline === 'object' && 'median' in baseline) {
    return {
      median: numberDelta(baseline.median, candidate.median),
      p90: numberDelta(baseline.p90, candidate.p90)
    }
  }
  if (baseline && typeof baseline === 'object' && 'weighted' in baseline) {
    return { weighted: numberDelta(baseline.weighted, candidate.weighted) }
  }
  return numberDelta(baseline, candidate)
}

function numberDelta(baseline, candidate) {
  if (typeof baseline !== 'number' || typeof candidate !== 'number') {
    return { absolute: null, relative: null }
  }
  const absolute = candidate - baseline
  return { absolute, relative: baseline === 0 ? null : absolute / baseline }
}

export function renderMarkdown(report) {
  if (report.baseline && report.candidate) {
    return [
      '# Turn metrics comparison',
      '',
      renderSummary('Baseline', report.baseline.summary),
      '',
      renderSummary('Candidate', report.candidate.summary),
      '',
      renderDelta(report.delta)
    ].join('\n')
  }
  return ['# Turn metrics', '', renderSummary('Summary', report.summary), '', renderTurns(report.turns)].join('\n')
}

function renderSummary(title, summary) {
  const lines = [`## ${title}`, '']
  for (const field of SUMMARY_FIELDS) {
    const stats = summary[field]
    lines.push(
      `- ${field}: median ${formatNumber(stats.median)}, p90 ${formatNumber(stats.p90)}, excluded ${stats.excluded}` +
        (field === 'decodeTokensPerSecond' ? `, slope ${formatNumber(stats.slopePerTurn)}` : '')
    )
  }
  lines.push(
    `- cacheHitRate: weighted ${formatNumber(summary.cacheHitRate.weighted)}, excluded ${summary.cacheHitRate.excluded}`
  )
  lines.push(`- harnessRatio: ${formatNumber(summary.harnessRatio)}`)
  return lines.join('\n')
}

function renderDelta(delta) {
  const lines = ['## Delta', '']
  for (const field of SUMMARY_FIELDS) {
    lines.push(
      `- ${field}: median absolute ${formatNumber(delta[field].median.absolute)}, relative ${formatNumber(delta[field].median.relative)}`
    )
  }
  lines.push(
    `- cacheHitRate: absolute ${formatNumber(delta.cacheHitRate.weighted.absolute)}, relative ${formatNumber(delta.cacheHitRate.weighted.relative)}`
  )
  lines.push(
    `- harnessRatio: absolute ${formatNumber(delta.harnessRatio.absolute)}, relative ${formatNumber(delta.harnessRatio.relative)}`
  )
  return lines.join('\n')
}

function renderTurns(turns) {
  const lines = ['## Turns', '', '| turn | ttft | decode | harness |', '| --- | --- | --- | --- |']
  for (const turn of turns) {
    lines.push(
      `| ${turn.turnIndex} | ${formatNumber(turn.timeToFirstTokenMs)} | ${formatNumber(turn.decodeTokensPerSecond)} | ${formatNumber(turn.harnessOverheadMs)} |`
    )
  }
  return lines.join('\n')
}

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'null'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(4)))
}

function argValues(argv, name) {
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1])
  }
  return values
}

function main(argv) {
  const json = argv.includes('--json')
  const baseline = argValues(argv, '--baseline')
  const candidate = argValues(argv, '--candidate')
  const input = argValues(argv, '--input')
  const report =
    baseline.length && candidate.length
      ? compare(loadRecords(baseline), loadRecords(candidate))
      : { summary: summarize(loadRecords(input)), turns: loadRecords(input) }
  process.stdout.write(json ? `${JSON.stringify(report)}\n` : `${renderMarkdown(report)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
