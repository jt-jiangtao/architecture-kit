import fs from 'node:fs'
import path from 'node:path'
import { exists, readStageJson, shouldSkipDir, writeStageJson } from './lib.js'
import type { ImportGraphReport } from './02-import-graph.js'
import type { ScriptsOrphansReport } from './05-scripts-orphans.js'
import type { AstReachabilityPackageResult } from './07-ast-package-reachability.js'

export interface TriageEvidence {
  from: string
  kind: string
  snippet: string
}

export interface TriageFileRecord {
  file: string
  verdict: string
  score: number
  isCompatStub: boolean
  evidenceCount: number
  evidences: TriageEvidence[]
}

export interface FalsePositiveTriageReport {
  candidateCount: number
  counts: Record<string, number>
  provenUnreachable: string[]
  likelyUnused: Array<{ file: string; score: number; isCompatStub: boolean }>
  keepProven: Array<{ file: string; score: number; evidences: TriageEvidence[] }>
  dynamicLoadRisk: Array<{ file: string; score: number; evidences: TriageEvidence[] }>
  needsConfirm: Array<{ file: string; score: number; evidences: TriageEvidence[] }>
  all: TriageFileRecord[]
}

const CORPUS_ROOTS = ['apps', 'packages', 'plugins', 'scripts', 'tests', 'docs', 'config', 'deploy', 'evals']
const DYNAMIC_HINT =
  /new Worker\b|worker_threads|child_process|spawn\(|execFile\(|fork\(|import\(|require\.resolve|path\.join\([^)]*['"`][^'"`]+['"`]|readFileSync\([^)]*['"`][^'"`]+\.(ts|js|mjs)/

function snippetAround(text: string, needle: string): string {
  const i = text.indexOf(needle)
  if (i < 0) return ''
  const start = Math.max(0, i - 40)
  return text
    .slice(start, i + needle.length + 60)
    .replace(/\s+/g, ' ')
    .slice(0, 140)
}

export function runFalsePositiveTriage(root: string, outDir: string): FalsePositiveTriageReport {
  const ig = readStageJson<Partial<ImportGraphReport>>(outDir, 'import-graph.json')
  const ast = readStageJson<Record<string, Partial<AstReachabilityPackageResult>>>(
    outDir,
    'ast-reachability.json'
  )
  const scriptsOrphans = readStageJson<Partial<ScriptsOrphansReport>>(outDir, 'scripts-orphans.json')

  const texts = new Map<string, string>()
  function walkAll(rel: string, pred: (name: string) => boolean) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) return
    const stack = [abs]
    while (stack.length) {
      const dir = stack.pop()!
      let ents: fs.Dirent[]
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of ents) {
        if (ent.isDirectory()) {
          if (shouldSkipDir(ent.name) || ent.name === 'vendor' || ent.name === 'dist') continue
          if (
            [
              'artifacts',
              'analysis',
              'evidence',
              'evidence-archive',
              'out',
              '.build',
              'node_modules',
              'test-results'
            ].includes(ent.name)
          ) {
            continue
          }
          stack.push(path.join(dir, ent.name))
        } else if (ent.isFile() && pred(ent.name)) {
          const relF = path.relative(root, path.join(dir, ent.name)).split(path.sep).join('/')
          if (relF.startsWith('apps/mobile/') || relF.startsWith('scripts/audit-redundant/')) continue
          try {
            const t = fs.readFileSync(path.join(root, relF), 'utf8')
            if (t.length < 1_200_000) texts.set(relF, t)
          } catch {
            continue
          }
        }
      }
    }
  }

  for (const r of CORPUS_ROOTS) {
    walkAll(r, (n) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|yml|yaml|html|css|sh|py)$/.test(n))
  }
  for (const f of [
    'package.json',
    'vitest.config.ts',
    'playwright.config.ts',
    'dependency-cruiser.config.cjs',
    'eslint.config.mjs'
  ]) {
    if (exists(root, f)) texts.set(f, fs.readFileSync(path.join(root, f), 'utf8'))
  }

  // Keep only literal script paths in evidence. Other hook arguments can be private.
  const hookFile = '.codex/hooks.json'
  const hookScripts = new Set<string>()
  if (exists(root, hookFile)) {
    const { hooks } = JSON.parse(fs.readFileSync(path.join(root, hookFile), 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string }> }>>
    }
    for (const groups of Object.values(hooks ?? {})) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          if (hook.type !== 'command' || typeof hook.command !== 'string') continue
          for (const match of hook.command.matchAll(
            /\bscripts\/[\w./-]+\.(?:[cm]?js|ts|sh|py)(?=["'\s]|$)/g
          )) {
            hookScripts.add(match[0])
          }
        }
      }
    }
  }

  function findUp(file: string, name: string): string | null {
    let dir = path.posix.dirname(file)
    for (let i = 0; i < 6; i++) {
      const cand = path.posix.join(dir, name)
      if (exists(root, cand)) return cand
      const parent = path.posix.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  function triageFile(file: string): TriageFileRecord {
    const base = path.posix.basename(file)
    const baseNoExt = base.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, '')
    const evidences: TriageEvidence[] = []
    let score = 0

    if (hookScripts.has(file)) {
      evidences.push({ from: hookFile, kind: 'hook-script-reference', snippet: file })
      score += 10
    }
    for (const [from, text] of texts) {
      if (from === file) continue
      if (text.includes(file)) {
        evidences.push({ from, kind: 'full-path', snippet: snippetAround(text, file) })
        score += 10
        continue
      }
      const patterns = [
        `/${baseNoExt}'`,
        `/${baseNoExt}"`,
        `/${baseNoExt}.js`,
        `/${baseNoExt}.ts`,
        `/${base}'`,
        `/${base}"`,
        `'${baseNoExt}'`,
        `"${baseNoExt}"`,
        `./${baseNoExt}`,
        `../${baseNoExt}`
      ]
      let hit = patterns.some((p) => text.includes(p))
      if (
        !hit &&
        (file.startsWith('scripts/') ||
          file.includes('/scripts/') ||
          file.includes('/skills/') ||
          file.includes('/resources/'))
      ) {
        if (text.includes(base)) hit = true
      }
      if (hit) {
        const dyn = DYNAMIC_HINT.test(text)
        evidences.push({
          from,
          kind: dyn ? 'name-ref-dynamic-context' : 'name-ref',
          snippet: snippetAround(text, baseNoExt)
        })
        score += dyn ? 8 : 5
      }
    }

    const pluginJson = findUp(file, 'plugin.json')
    if (pluginJson) {
      const pj = texts.get(pluginJson) || fs.readFileSync(path.join(root, pluginJson), 'utf8')
      if (
        pj.includes(base) ||
        pj.includes(baseNoExt) ||
        pj.includes(path.posix.relative(path.posix.dirname(pluginJson), file))
      ) {
        evidences.push({ from: pluginJson, kind: 'plugin.json', snippet: 'listed or path-related' })
        score += 12
      }
    }

    let content = ''
    try {
      content = fs.readFileSync(path.join(root, file), 'utf8')
    } catch {
      // ignore missing file
    }
    const isCompatStub =
      /Compatibility entry/.test(content) && content.split('\n').filter(Boolean).length <= 5

    let verdict: string
    if (isCompatStub && score === 0) verdict = 'needs-confirm'
    else if (score >= 10) verdict = 'keep-proven'
    else if (score >= 5) verdict = 'dynamic-load-risk'
    else if (score >= 1) verdict = 'needs-confirm'
    else verdict = 'likely-unused'

    if (/worker|hop\.mjs|probe\.mjs|format-worker/i.test(file) && score >= 1) {
      verdict = 'dynamic-load-risk'
    }
    if (/skills\/.+\/.+\.mjs$/.test(file) && score >= 1) {
      verdict = 'dynamic-load-risk'
    }

    return {
      file,
      verdict,
      score,
      isCompatStub,
      evidenceCount: evidences.length,
      evidences
    }
  }

  const candidates = new Set<string>([
    ...(ig.fullyOrphan || []),
    ...(ast['apps/desktop']?.unreachable || []),
    ...(ast['apps/local-runtime']?.unreachable || []),
    ...(ast['packages/computer-use/browser-runtime']?.unreachable || []),
    ...(ast['packages/office/onlyoffice-pdf']?.unreachable || []),
    ...(ast['packages/plugins/plugin-runtime']?.unreachable || []),
    ...(ast['plugins/presentations']?.unreachable || []),
    ...(ast['plugins/visual-creation']?.unreachable || []),
    ...(ast['plugins/office']?.unreachable || []),
    ...(scriptsOrphans.orphanCandidates || [])
  ])

  const results = [...candidates].sort().map((f) => triageFile(f))
  const byVerdict: Record<string, TriageFileRecord[]> = {}
  for (const r of results) {
    ;(byVerdict[r.verdict] ||= []).push(r)
  }

  const out: FalsePositiveTriageReport = {
    candidateCount: results.length,
    counts: Object.fromEntries(Object.entries(byVerdict).map(([k, v]) => [k, v.length])),
    provenUnreachable: (byVerdict['proven-unreachable'] || []).map((r) => r.file),
    likelyUnused: (byVerdict['likely-unused'] || []).map((r) => ({
      file: r.file,
      score: r.score,
      isCompatStub: r.isCompatStub
    })),
    keepProven: (byVerdict['keep-proven'] || []).map((r) => ({
      file: r.file,
      score: r.score,
      evidences: r.evidences.slice(0, 3)
    })),
    dynamicLoadRisk: (byVerdict['dynamic-load-risk'] || []).map((r) => ({
      file: r.file,
      score: r.score,
      evidences: r.evidences.slice(0, 3)
    })),
    needsConfirm: (byVerdict['needs-confirm'] || []).map((r) => ({
      file: r.file,
      score: r.score,
      evidences: r.evidences.slice(0, 3)
    })),
    all: results
  }
  writeStageJson(outDir, 'false-positive-triage.json', out)
  return out
}
