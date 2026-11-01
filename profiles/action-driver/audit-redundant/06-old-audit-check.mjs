#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, exists, walkFiles } from './lib.mjs'

const checks = [
  { id: 'langsmith-observability.ts', paths: ['packages/agent/agent-runtime'], pattern: /langsmith-observability/ },
  { id: 'direct langsmith dep', paths: ['packages', 'apps'], pattern: /["']langsmith["']/ },
  { id: 'model-log-projection', paths: ['packages', 'apps'], pattern: /model-log-projection|modelCalls|model_calls/ },
  { id: 'langsmith-detail-view', paths: ['apps/desktop'], pattern: /langsmith-detail|LangsmithDetail/ },
  { id: 'logs-ipc / log-ipc-contract', paths: ['apps/desktop', 'packages'], pattern: /logs-ipc|log-ipc-contract|registerLogIpcHandlers/ },
  { id: 'packages/observability', paths: ['packages'], pattern: null, dirGone: 'packages/observability' },
  { id: 'MemoryInteractionLogStore', paths: ['packages', 'apps', 'tests'], pattern: /MemoryInteractionLogStore/ },
  { id: 'ExecutionTimeline Checkbox RadioOption TextField', paths: ['apps/desktop', 'packages'], pattern: /ExecutionTimeline|\bCheckbox\b|\bRadioOption\b|\bTextField\b/ },
]

function scan(roots, pattern) {
  const hits = []
  for (const root of roots) {
    if (!exists(root)) continue
    // if root is a file path prefix with multiple segments
    const top = root.split('/')[0]
    for (const f of walkFiles(top === root ? root : top, { includeTests: true })) {
      if (!f.startsWith(root.replace(/\/$/, '') )) {
        // if root is packages, all packages ok; if packages/agent/agent-runtime, filter
        if (root.includes('/') && !f.startsWith(root)) continue
      } else {
        // ok
      }
      if (root.includes('/') && !f.startsWith(root)) continue
      let t
      try { t = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
      if (pattern.test(t)) hits.push(f)
    }
  }
  return hits
}

const results = []
for (const c of checks) {
  if (c.dirGone) {
    results.push({
      id: c.id,
      stillPresent: exists(c.dirGone),
      status: exists(c.dirGone) ? 'STILL_EXISTS' : 'GONE_AS_EXPECTED',
      hits: []
    })
    continue
  }
  const hits = scan(c.paths, c.pattern).filter(h => !h.includes('docs/') && !h.includes('unused-code-audit'))
  results.push({
    id: c.id,
    hitCount: hits.length,
    hits: hits.slice(0, 20),
    status: hits.length === 0 ? 'GONE_OR_CLEAN' : 'STILL_REFERENCED'
  })
}

fs.writeFileSync(auditOutput('old-audit-check.json'), JSON.stringify({ results }, null, 2))
console.log(JSON.stringify(results.map(r => ({ id: r.id, status: r.status, hitCount: r.hitCount })), null, 2))
