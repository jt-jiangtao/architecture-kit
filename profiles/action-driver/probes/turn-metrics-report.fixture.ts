import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = '__REPORT_SCRIPT__'

function turn(partial: Record<string, unknown>) {
  return {
    v: 1,
    sessionId: 'session',
    taskId: 'task',
    requestId: 'request',
    modelId: 'deepseek-flash',
    recordedAt: '2026-10-18T00:00:00.000Z',
    result: 'completed',
    timeToFirstContentMs: 1,
    modelStreamMs: 10,
    streamBlockMs: 5,
    outputTokens: 1,
    reasoningTokens: null,
    reasoningChars: 0,
    contentChars: 1,
    inputTokens: 100,
    retryCount: 0,
    failedAttemptMs: 0,
    backoffMs: 0,
    contextPrepareMs: 0,
    toolCallCount: 0,
    maxToolParallelism: 0,
    toolWallMs: 0,
    turnMs: 1000,
    harnessOverheadMs: 100,
    ...partial
  }
}

function writeJsonl(name: string, records: Array<Record<string, unknown>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'turn-metrics-report-'))
  const path = join(directory, name)
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  return path
}

function run(args: string[]): { stdout: string; json: unknown } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  const jsonRun = spawnSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' })
  expect(jsonRun.status).toBe(0)
  return { stdout: result.stdout, json: JSON.parse(jsonRun.stdout) }
}

describe('turn metrics report', () => {
  it('summarizes medians, weighted cache hit rate, harness ratio, and decode slope while excluding empty values', () => {
    const records = []
    for (let index = 1; index <= 10; index += 1) {
      const cached = index <= 6
      records.push(
        turn({
          turnIndex: index,
          timeToFirstTokenMs: index * 10,
          decodeTokensPerSecond: index <= 8 ? index * 10 : null,
          cachedInputTokens: cached ? 40 : null,
          cacheHitRate: cached ? 0.4 : null,
          streamBlockMs: 5,
          harnessOverheadMs: 100,
          turnMs: 1000
        })
      )
    }
    const path = writeJsonl('sample.jsonl', records)
    try {
      const { stdout, json } = run(['--input', path])
      const report = json as {
        summary: {
          timeToFirstTokenMs: { median: number; p90: number; excluded: number }
          decodeTokensPerSecond: { median: number; p90: number; excluded: number; slopePerTurn: number }
          streamBlockMs: { median: number; p90: number; excluded: number }
          harnessOverheadMs: { median: number; p90: number; excluded: number }
          cacheHitRate: { weighted: number; excluded: number }
          harnessRatio: number
        }
      }
      expect(report.summary.timeToFirstTokenMs).toEqual({ median: 55, p90: 91, excluded: 0 })
      expect(report.summary.decodeTokensPerSecond).toMatchObject({
        median: 45,
        p90: 73,
        excluded: 2,
        slopePerTurn: 10
      })
      expect(report.summary.streamBlockMs).toEqual({ median: 5, p90: 5, excluded: 0 })
      expect(report.summary.harnessOverheadMs).toEqual({ median: 100, p90: 100, excluded: 0 })
      expect(report.summary.cacheHitRate).toEqual({ weighted: 0.4, excluded: 4 })
      expect(report.summary.harnessRatio).toBe(0.1)
      expect(stdout).toContain('4')
      expect(stdout).toContain('0.4')
      expect(stdout).toContain('55')
      for (const value of [55, 91, 45, 73, 0.4, 0.1, 10]) {
        expect(stdout).toContain(String(value))
      }
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('prints baseline and candidate summaries with absolute and relative deltas', () => {
    const baseline = writeJsonl('baseline.jsonl', [
      turn({ turnIndex: 1, timeToFirstTokenMs: 50, decodeTokensPerSecond: 10, cachedInputTokens: 20, cacheHitRate: 0.2 }),
      turn({ turnIndex: 2, timeToFirstTokenMs: 60, decodeTokensPerSecond: 20, cachedInputTokens: 20, cacheHitRate: 0.2 })
    ])
    const candidate = writeJsonl('candidate.jsonl', [
      turn({ turnIndex: 1, timeToFirstTokenMs: 20, decodeTokensPerSecond: 30, cachedInputTokens: 50, cacheHitRate: 0.5 }),
      turn({ turnIndex: 2, timeToFirstTokenMs: 20, decodeTokensPerSecond: 40, cachedInputTokens: 50, cacheHitRate: 0.5 })
    ])
    try {
      const { stdout, json } = run(['--baseline', baseline, '--candidate', candidate])
      const report = json as {
        baseline: { summary: { timeToFirstTokenMs: { median: number } } }
        candidate: { summary: { timeToFirstTokenMs: { median: number } } }
        delta: { timeToFirstTokenMs: { median: { absolute: number; relative: number } } }
      }
      expect(report.baseline.summary.timeToFirstTokenMs.median).toBe(55)
      expect(report.candidate.summary.timeToFirstTokenMs.median).toBe(20)
      expect(report.delta.timeToFirstTokenMs.median.absolute).toBe(-35)
      expect(report.delta.timeToFirstTokenMs.median.relative).toBeCloseTo(-35 / 55)
      expect(stdout).toContain('-35')
      expect(stdout).toContain('55')
      expect(stdout).toContain('20')
    } finally {
      rmSync(join(baseline, '..'), { recursive: true, force: true })
      rmSync(join(candidate, '..'), { recursive: true, force: true })
    }
  })
})
