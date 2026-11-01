#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readJson, exists } from './lib.mjs'

const rootPkg = readJson('package.json')
const referenced = new Set()

function absorb(text) {
  if (!text) return
  for (const m of String(text).matchAll(/scripts\/[A-Za-z0-9_./-]+/g)) {
    referenced.add(m[0].replace(/\.$/, ''))
  }
}

absorb(JSON.stringify(rootPkg))
// all workspace package.json
for (const root of ['apps', 'packages', 'plugins']) {
  if (!exists(root)) continue
  for (const name of fs.readdirSync(path.join(ROOT, root))) {
    const pj = `${root}/${name}/package.json`
    if (!exists(pj)) continue
    absorb(fs.readFileSync(path.join(ROOT, pj), 'utf8'))
  }
}

function walkAll(rel, pred) {
  const abs = path.join(ROOT, rel)
  const out = []
  if (!fs.existsSync(abs)) return out
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'artifacts' || ent.name === 'analysis' || ent.name === 'evidence' || ent.name === 'evidence-archive' || ent.name === 'out' || ent.name === '.build') continue
      const full = path.join(dir, ent.name)
      if (full === process.env.ARCHITECTURE_KIT_PROFILE_OUTPUT) continue
      if (ent.isDirectory()) stack.push(full)
      else if (pred(ent.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'))
    }
  }
  return out
}

for (const f of walkAll('.', n => /\.(yml|yaml|md|mjs|sh|json|ts)$/.test(n))) {
  if (f.startsWith('scripts/audit-redundant/')) continue
  if (f.length > 200000) continue
  try {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
    if (t.length > 500000) continue
    absorb(t)
  } catch {}
}

const scriptFiles = walkAll('scripts', n => /\.(mjs|js|ts|sh|py|cjs)$/.test(n))
  .filter(f => !f.startsWith('scripts/audit-redundant/'))

const orphans = []
const referencedList = [...referenced]
for (const f of scriptFiles) {
  const base = path.posix.basename(f)
  const hit = referencedList.some(r =>
    r === f ||
    r.endsWith('/' + base) ||
    f.startsWith(r.replace(/\.(mjs|js|ts|sh)$/, '')) ||
    r.includes(base)
  )
  // also if imported by another script
  if (!hit) orphans.push(f)
}

// second pass: scripts importing orphans
const scriptTexts = new Map()
for (const f of scriptFiles) {
  try { scriptTexts.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8')) } catch {}
}
const kept = new Set()
for (const f of scriptFiles) {
  if (!orphans.includes(f)) kept.add(f)
}
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

const out = {
  scriptFileCount: scriptFiles.length,
  referencedHintCount: referenced.size,
  orphanCandidates: orphans.sort(),
  orphanCount: orphans.length
}
fs.writeFileSync(auditOutput('scripts-orphans.json'), JSON.stringify(out, null, 2))
console.log(`scripts=${scriptFiles.length} orphanCandidates=${orphans.length}`)
orphans.slice(0, 30).forEach(o => console.log('  ', o))
