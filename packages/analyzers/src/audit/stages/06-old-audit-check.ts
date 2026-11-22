import fs from 'node:fs'
import path from 'node:path'
import { exists, walkFiles, writeStageJson } from './lib.js'

export interface OldAuditCheckSpec {
  id: string
  paths: string[]
  pattern?: RegExp | null | undefined
  dirGone?: string | undefined
}

const DEFAULT_CHECKS: readonly OldAuditCheckSpec[] = [
  {
    id: 'langsmith-observability.ts',
    paths: ['packages/agent/agent-runtime'],
    pattern: /langsmith-observability/
  },
  { id: 'direct langsmith dep', paths: ['packages', 'apps'], pattern: /["']langsmith["']/ },
  {
    id: 'model-log-projection',
    paths: ['packages', 'apps'],
    pattern: /model-log-projection|modelCalls|model_calls/
  },
  {
    id: 'langsmith-detail-view',
    paths: ['apps/desktop'],
    pattern: /langsmith-detail|LangsmithDetail/
  },
  {
    id: 'logs-ipc / log-ipc-contract',
    paths: ['apps/desktop', 'packages'],
    pattern: /logs-ipc|log-ipc-contract|registerLogIpcHandlers/
  },
  {
    id: 'packages/observability',
    paths: ['packages'],
    pattern: null,
    dirGone: 'packages/observability'
  },
  {
    id: 'MemoryInteractionLogStore',
    paths: ['packages', 'apps', 'tests'],
    pattern: /MemoryInteractionLogStore/
  },
  {
    id: 'ExecutionTimeline Checkbox RadioOption TextField',
    paths: ['apps/desktop', 'packages'],
    pattern: /ExecutionTimeline|\bCheckbox\b|\bRadioOption\b|\bTextField\b/
  }
]

function scan(root: string, roots: string[], pattern: RegExp): string[] {
  const hits: string[] = []
  for (const r of roots) {
    if (!exists(root, r)) continue
    const top = r.split('/')[0]!
    for (const f of walkFiles(root, top === r ? r : top, { includeTests: true })) {
      if (r.includes('/') && !f.startsWith(r)) continue
      let t: string
      try {
        t = fs.readFileSync(path.join(root, f), 'utf8')
      } catch {
        continue
      }
      if (pattern.test(t)) hits.push(f)
    }
  }
  return hits
}

export function runOldAuditCheck(
  root: string,
  outDir: string,
  checks: readonly OldAuditCheckSpec[] = DEFAULT_CHECKS
) {
  const results = []
  for (const c of checks) {
    if (c.dirGone) {
      const stillPresent = exists(root, c.dirGone)
      results.push({
        id: c.id,
        stillPresent,
        status: stillPresent ? 'STILL_EXISTS' : 'GONE_AS_EXPECTED',
        hits: [] as string[]
      })
      continue
    }
    const hits = c.pattern
      ? scan(root, c.paths, c.pattern).filter(
          (h) => !h.includes('docs/') && !h.includes('unused-code-audit')
        )
      : []
    results.push({
      id: c.id,
      hitCount: hits.length,
      hits: hits.slice(0, 20),
      status: hits.length === 0 ? 'GONE_OR_CLEAN' : 'STILL_REFERENCED'
    })
  }
  const out = { results }
  writeStageJson(outDir, 'old-audit-check.json', out)
  return out
}
