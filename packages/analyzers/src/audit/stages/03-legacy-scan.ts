import fs from 'node:fs'
import path from 'node:path'
import { walkFiles, writeStageJson } from './lib.js'

const PATTERNS = [
  { id: 'compat', re: /\bCompat\b|compat(?:ibility)?|backward[- ]?compat/i },
  { id: 'legacy', re: /\bLegacy\b|\blegacy\b/ },
  { id: 'deprecated', re: /@deprecated|\bDeprecated\b|\bdeprecated\b/ },
  { id: 'shim', re: /\bshim\b|\bShims?\b/ },
  { id: 'obsolete', re: /\bobsolete\b|\bobsoleted\b/i },
  { id: 'migration', re: /\bmigration\b|\bmigrate[A-Z]|TODO remove|FIXME remove|to be removed/i },
  { id: 'alias-reexport', re: /export\s+\*\s+from|export\s+\{[^}]+\}\s+from/ },
  { id: 'feature-flag-old', re: /featureFlag|FEATURE_|enableLegacy|useLegacy|legacyMode|compatMode/i }
]

const nameRe = /compat|legacy|deprecated|shim|obsolete|old-|-old\./i
const pathRe = /\/compat\/|\/legacy\/|\/deprecated\//i
const aliasContextRe = /compat|legacy|deprecated|shim|obsolete|old|alias|backward/i

export interface LegacyScanHit {
  pattern: string
  file: string
  line: number
  text: string
}

export interface LegacyScanReport {
  filesScanned: number
  hitCount: number
  nameHits: string[]
  byPattern: Record<string, { count: number; sample: LegacyScanHit[] }>
  byModule: Record<string, { count: number; patterns: Record<string, number> }>
  hits: LegacyScanHit[]
}

export function runLegacyScan(root: string, outDir: string): LegacyScanReport {
  const hits: LegacyScanHit[] = []
  const nameHits: string[] = []
  const SCOPE = ['apps', 'packages', 'plugins', 'scripts']
  let filesScanned = 0

  for (const scopeRoot of SCOPE) {
    for (const file of walkFiles(root, scopeRoot, { includeTests: true })) {
      if (file.startsWith('apps/mobile/') || file.includes('/vendor/')) continue
      filesScanned++
      let src: string
      try {
        src = fs.readFileSync(path.join(root, file), 'utf8')
      } catch {
        continue
      }
      if (src.length > 2_000_000) continue
      const lines = src.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        for (const p of PATTERNS) {
          if (p.id === 'alias-reexport' && !aliasContextRe.test(file) && !aliasContextRe.test(line)) {
            continue
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
      if (nameRe.test(path.basename(file)) || pathRe.test(file)) {
        nameHits.push(file)
      }
    }
  }

  const mod = (f: string) => {
    const p = f.split('/')
    return p[0] === 'scripts' ? 'scripts' : p.slice(0, 2).join('/')
  }
  const byPattern: Record<string, LegacyScanHit[]> = {}
  const byModule: Record<string, { count: number; patterns: Record<string, number> }> = {}
  for (const h of hits) {
    ;(byPattern[h.pattern] ||= []).push(h)
    const m = mod(h.file)
    const modRec = (byModule[m] ||= { count: 0, patterns: {} })
    modRec.count++
    modRec.patterns[h.pattern] = (modRec.patterns[h.pattern] || 0) + 1
  }

  const out: LegacyScanReport = {
    filesScanned,
    hitCount: hits.length,
    nameHits,
    byPattern: Object.fromEntries(
      Object.entries(byPattern).map(([k, v]) => [k, { count: v.length, sample: v.slice(0, 40) }])
    ),
    byModule,
    hits: hits.length > 5000 ? hits.slice(0, 5000) : hits
  }
  writeStageJson(outDir, 'legacy.json', out)
  return out
}
