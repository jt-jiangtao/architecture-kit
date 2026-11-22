import { readStageJson, writeStageJson } from './lib.js'
import type { AstReachabilityPackageResult } from './07-ast-package-reachability.js'
import type { FalsePositiveTriageReport, TriageEvidence } from './08-false-positive-triage.js'

export interface RefinedTriageReport {
  counts: Record<string, number>
  provenUnreachable: string[]
  testOnly: Array<{ file: string; note: string }>
  likelyUnused: Array<{ file: string; note: string; isCompatStub: boolean }>
  keepProven: Array<{ file: string; note: string }>
  dynamicLoadRisk: Array<{ file: string; note: string }>
  downgradedFromPass1: { description: string }
  desktopReclass: Array<{ file: string; verdict: string; note: string }>
}

const isTestPath = (f: string) => /(^|\/)(tests|__tests__|e2e)(\/)/.test(f) || /\.(test|spec)\./.test(f)
const isDocPath = (f: string) => f.startsWith('docs/')

export function runRefineTriage(_root: string, outDir: string): RefinedTriageReport {
  const raw = readStageJson<FalsePositiveTriageReport>(outDir, 'false-positive-triage.json')
  const refined: Array<{
    file: string
    verdict: string
    note: string
    isCompatStub: boolean
    prodEvidence: TriageEvidence[]
    testEvidence: TriageEvidence[]
  }> = []

  for (const r of raw.all || []) {
    if (r.file.startsWith('scripts/audit-redundant/')) continue
    const ev = (r.evidences || []).filter((e) => !isDocPath(e.from))
    const prodEv = ev.filter((e) => !isTestPath(e.from))
    const testEv = ev.filter((e) => isTestPath(e.from))
    let verdict = r.verdict
    let note = ''

    if (r.isCompatStub && prodEv.length === 0 && testEv.length === 0) {
      verdict = 'needs-confirm'
      note = 'compat stub, zero non-doc refs'
    } else if (prodEv.length > 0) {
      const dyn = prodEv.some(
        (e) =>
          e.kind.includes('dynamic') ||
          /worker|hop|join\(|spawn|plugin\.json|skill/i.test(JSON.stringify(e))
      )
      verdict =
        dyn || /worker|hop\.mjs|skills\//.test(r.file) ? 'dynamic-load-risk' : 'keep-proven'
      note = `prod refs: ${prodEv
        .map((e) => e.from)
        .slice(0, 3)
        .join(', ')}`
    } else if (testEv.length > 0) {
      verdict = 'test-only'
      note = `only tests: ${testEv
        .map((e) => e.from)
        .slice(0, 3)
        .join(', ')}`
    } else if (r.verdict === 'proven-unreachable' || r.isCompatStub) {
      verdict = 'needs-confirm'
    } else {
      verdict = 'likely-unused'
      note = 'no prod/test refs after ignoring docs'
    }

    if (/vitest\.config\.|playwright\.config\.|vite\.config\./.test(r.file)) {
      verdict = 'keep-proven'
      note = 'tooling config file'
    }

    refined.push({
      file: r.file,
      verdict,
      note,
      isCompatStub: r.isCompatStub,
      prodEvidence: prodEv.slice(0, 5),
      testEvidence: testEv.slice(0, 5)
    })
  }

  const by: Record<string, typeof refined> = {}
  for (const r of refined) {
    ;(by[r.verdict] ||= []).push(r)
  }

  const ast = readStageJson<Record<string, Partial<AstReachabilityPackageResult>>>(
    outDir,
    'ast-reachability.json'
  )
  const desktopWas = new Set(ast['apps/desktop']?.unreachable || [])

  const out: RefinedTriageReport = {
    counts: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])),
    provenUnreachable: (by['proven-unreachable'] || []).map((r) => r.file),
    testOnly: (by['test-only'] || []).map((r) => ({ file: r.file, note: r.note })),
    likelyUnused: (by['likely-unused'] || []).map((r) => ({
      file: r.file,
      note: r.note,
      isCompatStub: r.isCompatStub
    })),
    keepProven: (by['keep-proven'] || []).map((r) => ({ file: r.file, note: r.note })),
    dynamicLoadRisk: (by['dynamic-load-risk'] || []).map((r) => ({ file: r.file, note: r.note })),
    downgradedFromPass1: {
      description:
        'Pass1 orphan/unreachable items now keep-proven or dynamic-load-risk after evidence'
    },
    desktopReclass: [...desktopWas].map((f) => {
      const r = refined.find((x) => x.file === f)
      return { file: f, verdict: r?.verdict || 'missing', note: r?.note || '' }
    })
  }
  writeStageJson(outDir, 'false-positive-refined.json', out)
  return out
}
