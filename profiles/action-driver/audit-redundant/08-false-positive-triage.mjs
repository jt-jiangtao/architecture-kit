#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
/**
 * Triage import-graph orphans + AST unreachable lists:
 * search for basename / relative path / package subpath string refs,
 * Worker/child_process/plugin.json/skill/vite config hits.
 * Classify: keep-proven | dynamic-load-risk | likely-unused | needs-confirm
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, exists, shouldSkipDir
} from './lib.mjs'

const ig = JSON.parse(fs.readFileSync(auditOutput('import-graph.json'), 'utf8'))
const ast = JSON.parse(fs.readFileSync(auditOutput('ast-reachability.json'), 'utf8'))
const scriptsOrphans = JSON.parse(fs.readFileSync(auditOutput('scripts-orphans.json'), 'utf8'))

// Build searchable corpus (text index) — apps/packages/plugins/scripts/tests/docs/config/deploy
const CORPUS_ROOTS = ['apps', 'packages', 'plugins', 'scripts', 'tests', 'docs', 'config', 'deploy', 'evals']
const texts = new Map()
function walkAll(rel, pred) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) return
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of ents) {
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name) || ent.name === 'vendor' || ent.name === 'dist') continue
        if (['artifacts', 'analysis', 'evidence', 'evidence-archive', 'out', '.build', 'node_modules', 'test-results'].includes(ent.name)) continue
        stack.push(path.join(dir, ent.name))
      } else if (ent.isFile() && pred(ent.name)) {
        const relF = path.relative(ROOT, path.join(dir, ent.name)).split(path.sep).join('/')
        if (relF.startsWith('apps/mobile/')) continue
        if (relF.startsWith('scripts/audit-redundant/')) continue
        try {
          const t = fs.readFileSync(path.join(ROOT, relF), 'utf8')
          if (t.length < 1_200_000) texts.set(relF, t)
        } catch {}
      }
    }
  }
}
for (const r of CORPUS_ROOTS) {
  walkAll(r, n => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|yml|yaml|html|css|sh|py|mjs)$/.test(n))
}
// also root configs
for (const f of ['package.json', 'vitest.config.ts', 'playwright.config.ts', 'dependency-cruiser.config.cjs', 'eslint.config.mjs']) {
  if (exists(f)) texts.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8'))
}
// Keep only literal script paths in evidence. Other hook arguments can be private.
const hookFile = '.codex/hooks.json'
const hookScripts = new Set()
if (exists(hookFile)) {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(ROOT, hookFile), 'utf8'))
  for (const groups of Object.values(hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (hook.type !== 'command' || typeof hook.command !== 'string') continue
        for (const match of hook.command.matchAll(/\bscripts\/[\w./-]+\.(?:[cm]?js|ts|sh|py)(?=["'\s]|$)/g))
          hookScripts.add(match[0])
      }
    }
  }
}
console.log(`corpus files: ${texts.size}`)

const DYNAMIC_HINT = /new Worker\b|worker_threads|child_process|spawn\(|execFile\(|fork\(|import\(|require\.resolve|path\.join\([^)]*['"`][^'"`]+['"`]|readFileSync\([^)]*['"`][^'"`]+\.(ts|js|mjs)/

function triageFile(file) {
  const base = path.posix.basename(file)
  const baseNoExt = base.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, '')
  const evidences = []
  let score = 0 // higher = more likely still used

  if (hookScripts.has(file)) {
    evidences.push({ from: hookFile, kind: 'hook-script-reference', snippet: file })
    score += 10
  }
  for (const [from, text] of texts) {
    if (from === file) continue
    // exact path mention
    if (text.includes(file)) {
      evidences.push({ from, kind: 'full-path', snippet: snippetAround(text, file) })
      score += 10
      continue
    }
    // basename as module specifier piece
    const patterns = [
      `/${baseNoExt}'`, `/${baseNoExt}"`, `/${baseNoExt}.js`, `/${baseNoExt}.ts`,
      `/${base}'`, `/${base}"`,
      `'${baseNoExt}'`, `"${baseNoExt}"`,
      `./${baseNoExt}`, `../${baseNoExt}`,
    ]
    let hit = false
    for (const p of patterns) {
      if (text.includes(p)) { hit = true; break }
    }
    // also bare basename in join/spawn strings for scripts
    if (!hit && (file.startsWith('scripts/') || file.includes('/scripts/') || file.includes('/skills/') || file.includes('/resources/'))) {
      if (text.includes(base)) hit = true
    }
    if (hit) {
      const dyn = DYNAMIC_HINT.test(text)
      evidences.push({ from, kind: dyn ? 'name-ref-dynamic-context' : 'name-ref', snippet: snippetAround(text, baseNoExt) })
      score += dyn ? 8 : 5
    }
  }

  // plugin.json / skill.md near file
  const pluginJson = findUp(file, 'plugin.json')
  if (pluginJson) {
    const pj = texts.get(pluginJson) || fs.readFileSync(path.join(ROOT, pluginJson), 'utf8')
    if (pj.includes(base) || pj.includes(baseNoExt) || pj.includes(path.posix.relative(path.posix.dirname(pluginJson), file))) {
      evidences.push({ from: pluginJson, kind: 'plugin.json', snippet: 'listed or path-related' })
      score += 12
    }
  }

  // special: Compatibility entry stubs with zero refs
  let content = ''
  try { content = fs.readFileSync(path.join(ROOT, file), 'utf8') } catch {}
  const isCompatStub = /Compatibility entry/.test(content) && content.split('\n').filter(Boolean).length <= 5

  let verdict
  if (isCompatStub && score === 0) verdict = 'needs-confirm'
  else if (score >= 10) verdict = 'keep-proven'
  else if (score >= 5) verdict = 'dynamic-load-risk'
  else if (score >= 1) verdict = 'needs-confirm'
  else verdict = 'likely-unused'

  // override: worker/hop naming
  if (/worker|hop\.mjs|probe\.mjs|format-worker/i.test(file) && score >= 1) verdict = 'dynamic-load-risk'
  if (/skills\/.+\/.+\.mjs$/.test(file) && score >= 1) verdict = 'dynamic-load-risk'

  return {
    file,
    verdict,
    score,
    isCompatStub,
    evidenceCount: evidences.length,
    evidences
  }
}

function snippetAround(text, needle) {
  const i = text.indexOf(needle)
  if (i < 0) return ''
  const start = Math.max(0, i - 40)
  return text.slice(start, i + needle.length + 60).replace(/\s+/g, ' ').slice(0, 140)
}

function findUp(file, name) {
  let dir = path.posix.dirname(file)
  for (let i = 0; i < 6; i++) {
    const cand = path.posix.join(dir, name)
    if (exists(cand)) return cand
    const parent = path.posix.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// Candidates: fully orphan + AST unreachable from key packages + script orphans
const candidates = new Set([
  ...ig.fullyOrphan,
  ...(ast['apps/desktop']?.unreachable || []),
  ...(ast['apps/local-runtime']?.unreachable || []),
  ...(ast['packages/browser-runtime']?.unreachable || []),
  ...(ast['packages/onlyoffice-pdf']?.unreachable || []),
  ...(ast['packages/plugin-runtime']?.unreachable || []),
  ...(ast['plugins/presentations']?.unreachable || []),
  ...(ast['plugins/visual-creation']?.unreachable || []),
  ...(ast['plugins/office']?.unreachable || []),
  ...(scriptsOrphans.orphanCandidates || []),
])

console.log(`triaging ${candidates.size} candidates...`)
const results = []
let i = 0
for (const f of [...candidates].sort()) {
  i++
  if (i % 50 === 0) process.stderr.write(`\rtriage ${i}/${candidates.size}`)
  results.push(triageFile(f))
}
process.stderr.write('\n')

const byVerdict = {}
for (const r of results) {
  ;(byVerdict[r.verdict] ||= []).push(r)
}

const out = {
  candidateCount: results.length,
  counts: Object.fromEntries(Object.entries(byVerdict).map(([k, v]) => [k, v.length])),
  provenUnreachable: (byVerdict['proven-unreachable'] || []).map(r => r.file),
  likelyUnused: (byVerdict['likely-unused'] || []).map(r => ({ file: r.file, score: r.score, isCompatStub: r.isCompatStub })),
  keepProven: (byVerdict['keep-proven'] || []).map(r => ({ file: r.file, score: r.score, evidences: r.evidences.slice(0, 3) })),
  dynamicLoadRisk: (byVerdict['dynamic-load-risk'] || []).map(r => ({ file: r.file, score: r.score, evidences: r.evidences.slice(0, 3) })),
  needsConfirm: (byVerdict['needs-confirm'] || []).map(r => ({ file: r.file, score: r.score, evidences: r.evidences.slice(0, 3) })),
  all: results
}

fs.writeFileSync(auditOutput('false-positive-triage.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out.counts, null, 2))
console.log('proven-unreachable', out.provenUnreachable.length)
console.log('keep-proven sample', out.keepProven.slice(0, 8).map(x => x.file))
console.log('likely-unused non-stub', out.likelyUnused.filter(x => !x.isCompatStub).slice(0, 25).map(x => x.file))
