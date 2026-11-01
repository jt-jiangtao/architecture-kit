#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
/**
 * Reclassify triage results: ignore docs/ as keep evidence;
 * mark test-only production files separately; exclude audit-redundant scripts.
 */
import fs from 'node:fs'

const raw = JSON.parse(fs.readFileSync(auditOutput('false-positive-triage.json'), 'utf8'))

function isTestPath(f) {
  return /(^|\/)(tests|__tests__|e2e)(\/)/.test(f) || /\.(test|spec)\./.test(f)
}
function isDocPath(f) {
  return f.startsWith('docs/')
}

const refined = []
for (const r of raw.all) {
  if (r.file.startsWith('scripts/audit-redundant/')) continue
  const ev = (r.evidences || []).filter(e => !isDocPath(e.from))
  const prodEv = ev.filter(e => !isTestPath(e.from))
  const testEv = ev.filter(e => isTestPath(e.from))
  let verdict = r.verdict
  let note = ''

  if (r.isCompatStub && prodEv.length === 0 && testEv.length === 0) {
    verdict = 'needs-confirm'
    note = 'compat stub, zero non-doc refs'
  } else if (prodEv.length > 0) {
    const dyn = prodEv.some(e => e.kind.includes('dynamic') || /worker|hop|join\(|spawn|plugin\.json|skill/i.test(JSON.stringify(e)))
    verdict = dyn || /worker|hop\.mjs|skills\//.test(r.file) ? 'dynamic-load-risk' : 'keep-proven'
    note = `prod refs: ${prodEv.map(e => e.from).slice(0, 3).join(', ')}`
  } else if (testEv.length > 0) {
    verdict = 'test-only'
    note = `only tests: ${testEv.map(e => e.from).slice(0, 3).join(', ')}`
  } else if (r.verdict === 'proven-unreachable' || r.isCompatStub) {
    verdict = 'needs-confirm'
  } else {
    verdict = 'likely-unused'
    note = 'no prod/test refs after ignoring docs'
  }

  // vitest.config etc are configs — keep
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

const by = {}
for (const r of refined) (by[r.verdict] ||= []).push(r)

const out = {
  counts: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])),
  provenUnreachable: (by['proven-unreachable'] || []).map(r => r.file),
  testOnly: (by['test-only'] || []).map(r => ({ file: r.file, note: r.note })),
  likelyUnused: (by['likely-unused'] || []).map(r => ({ file: r.file, note: r.note, isCompatStub: r.isCompatStub })),
  keepProven: (by['keep-proven'] || []).map(r => ({ file: r.file, note: r.note })),
  dynamicLoadRisk: (by['dynamic-load-risk'] || []).map(r => ({ file: r.file, note: r.note })),
  downgradedFromPass1: {
    // files pass1 said deletable-ish but now keep/dynamic
    description: 'Pass1 orphan/unreachable items now keep-proven or dynamic-load-risk after evidence'
  }
}

// Compare to pass1 desktop unreachable
const ast = JSON.parse(fs.readFileSync(auditOutput('ast-reachability.json'), 'utf8'))
const desktopWas = new Set(ast['apps/desktop']?.unreachable || [])
out.desktopReclass = [...desktopWas].map(f => {
  const r = refined.find(x => x.file === f)
  return { file: f, verdict: r?.verdict || 'missing', note: r?.note || '' }
})

fs.writeFileSync(auditOutput('false-positive-refined.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out.counts, null, 2))
console.log('proven', out.provenUnreachable.length)
console.log('test-only sample', out.testOnly.slice(0, 15))
console.log('likely-unused', out.likelyUnused.map(x => x.file))
console.log('desktop reclass', out.desktopReclass)
