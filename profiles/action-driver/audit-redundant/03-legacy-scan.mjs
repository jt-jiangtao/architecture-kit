#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, walkFiles } from './lib.mjs'

const PATTERNS = [
  { id: 'compat', re: new RegExp(String.raw`\bCompat\b|compat(?:ibility)?|backward[- ]?compat`, 'i') },
  { id: 'legacy', re: new RegExp(String.raw`\bLegacy\b|\blegacy\b`) },
  { id: 'deprecated', re: new RegExp(String.raw`@deprecated|\bDeprecated\b|\bdeprecated\b`) },
  { id: 'shim', re: new RegExp(String.raw`\bshim\b|\bShims?\b`) },
  { id: 'obsolete', re: new RegExp(String.raw`\bobsolete\b|\bobsoleted\b`, 'i') },
  { id: 'migration', re: new RegExp(String.raw`\bmigration\b|\bmigrate[A-Z]|TODO remove|FIXME remove|to be removed`, 'i') },
  { id: 'alias-reexport', re: new RegExp(String.raw`export\s+\*\s+from|export\s+\{[^}]+\}\s+from`) },
  { id: 'feature-flag-old', re: new RegExp(String.raw`featureFlag|FEATURE_|enableLegacy|useLegacy|legacyMode|compatMode`, 'i') },
]

const nameRe = new RegExp(String.raw`compat|legacy|deprecated|shim|obsolete|old-|-old\.`, 'i')
const pathRe = new RegExp(String.raw`/compat/|/legacy/|/deprecated/`, 'i')
const aliasContextRe = new RegExp(String.raw`compat|legacy|deprecated|shim|obsolete|old|alias|backward`, 'i')

const hits = []
const SCOPE = ['apps', 'packages', 'plugins', 'scripts']
let filesScanned = 0

for (const root of SCOPE) {
  for (const file of walkFiles(root, { includeTests: true })) {
    if (file.startsWith('apps/mobile/')) continue
    if (file.includes('/vendor/')) continue
    filesScanned++
    let src
    try { src = fs.readFileSync(path.join(ROOT, file), 'utf8') } catch { continue }
    if (src.length > 2_000_000) continue
    const lines = src.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const p of PATTERNS) {
        if (p.id === 'alias-reexport') {
          if (!aliasContextRe.test(file) && !aliasContextRe.test(line)) continue
        }
        if (p.re.test(line)) {
          hits.push({
            pattern: p.id,
            file,
            line: i + 1,
            text: line.trim().slice(0, 240)
          })
          break
        }
      }
    }
  }
}

const nameHits = []
for (const root of SCOPE) {
  for (const file of walkFiles(root, { includeTests: true })) {
    if (file.startsWith('apps/mobile/')) continue
    if (nameRe.test(path.basename(file)) || pathRe.test(file)) {
      nameHits.push(file)
    }
  }
}

function mod(f) {
  const p = f.split('/')
  if (p[0] === 'scripts') return 'scripts'
  return p.slice(0, 2).join('/')
}

const byPattern = {}
for (const h of hits) {
  ;(byPattern[h.pattern] ||= []).push(h)
}

const byModule = {}
for (const h of hits) {
  const m = mod(h.file)
  ;(byModule[m] ||= { count: 0, patterns: {} })
  byModule[m].count++
  byModule[m].patterns[h.pattern] = (byModule[m].patterns[h.pattern] || 0) + 1
}

const out = {
  filesScanned,
  hitCount: hits.length,
  nameHits,
  byPattern: Object.fromEntries(Object.entries(byPattern).map(([k, v]) => [k, { count: v.length, sample: v.slice(0, 40) }])),
  byModule,
  hits: hits.length > 5000 ? hits.slice(0, 5000) : hits
}

fs.writeFileSync(auditOutput('legacy.json'), JSON.stringify(out, null, 2))
console.log(`files=${filesScanned} hits=${hits.length} nameHits=${nameHits.length}`)
for (const [k, v] of Object.entries(out.byPattern)) console.log(`  ${k}: ${v.count}`)
