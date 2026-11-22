import fs from 'node:fs'
import path from 'node:path'
import { exists, readJson, writeStageJson } from './lib.js'

export interface ScriptsOrphansReport {
  scriptFileCount: number
  referencedHintCount: number
  orphanCandidates: string[]
  orphanCount: number
}

const SKIP = new Set([
  'node_modules',
  '.git',
  'artifacts',
  'analysis',
  'evidence',
  'evidence-archive',
  'out',
  '.build'
])

function walkAll(root: string, rel: string, pred: (name: string) => boolean): string[] {
  const abs = path.join(root, rel)
  const out: string[] = []
  if (!fs.existsSync(abs)) return out
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (SKIP.has(ent.name)) continue
      const full = path.join(dir, ent.name)
      if (full === process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT) continue
      if (ent.isDirectory()) stack.push(full)
      else if (pred(ent.name)) out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  return out
}

export function runScriptsOrphans(root: string, outDir: string): ScriptsOrphansReport {
  const referenced = new Set<string>()
  const absorb = (text: string | undefined) => {
    if (!text) return
    for (const m of String(text).matchAll(/scripts\/[A-Za-z0-9_./-]+/g)) {
      referenced.add(m[0].replace(/\.$/, ''))
    }
  }

  if (exists(root, 'package.json')) absorb(JSON.stringify(readJson(root, 'package.json')))
  for (const group of ['apps', 'packages', 'plugins']) {
    if (!exists(root, group)) continue
    for (const name of fs.readdirSync(path.join(root, group))) {
      const pj = `${group}/${name}/package.json`
      if (exists(root, pj)) absorb(fs.readFileSync(path.join(root, pj), 'utf8'))
    }
  }

  for (const f of walkAll(root, '.', (n) => /\.(yml|yaml|md|mjs|sh|json|ts)$/.test(n))) {
    if (f.startsWith('scripts/audit-redundant/') || f.length > 200_000) continue
    try {
      const t = fs.readFileSync(path.join(root, f), 'utf8')
      if (t.length <= 500_000) absorb(t)
    } catch {
      continue
    }
  }

  const scriptFiles = walkAll(root, 'scripts', (n) => /\.(mjs|js|ts|sh|py|cjs)$/.test(n)).filter(
    (f) => !f.startsWith('scripts/audit-redundant/')
  )

  const orphans: string[] = []
  const referencedList = [...referenced]
  for (const f of scriptFiles) {
    const base = path.posix.basename(f)
    const hit = referencedList.some(
      (r) =>
        r === f ||
        r.endsWith('/' + base) ||
        f.startsWith(r.replace(/\.(mjs|js|ts|sh)$/, '')) ||
        r.includes(base)
    )
    if (!hit) orphans.push(f)
  }

  const scriptTexts = new Map<string, string>()
  for (const f of scriptFiles) {
    try {
      scriptTexts.set(f, fs.readFileSync(path.join(root, f), 'utf8'))
    } catch {
      continue
    }
  }
  const kept = new Set(scriptFiles.filter((f) => !orphans.includes(f)))
  let changed = true
  while (changed) {
    changed = false
    for (const o of [...orphans]) {
      for (const k of kept) {
        const t = scriptTexts.get(k) || ''
        if (t.includes(path.posix.basename(o)) || t.includes(o)) {
          kept.add(o)
          orphans.splice(orphans.indexOf(o), 1)
          changed = true
          break
        }
      }
    }
  }

  const out: ScriptsOrphansReport = {
    scriptFileCount: scriptFiles.length,
    referencedHintCount: referenced.size,
    orphanCandidates: orphans.sort(),
    orphanCount: orphans.length
  }
  writeStageJson(outDir, 'scripts-orphans.json', out)
  return out
}
