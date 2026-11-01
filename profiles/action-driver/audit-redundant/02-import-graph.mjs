#!/usr/bin/env node
import { auditOutput } from './output-native.mjs'
/**
 * Build static import graph across apps/packages/plugins (+ first-party scripts),
 * BFS from entries, report unreachable source files (excluding tests optionally).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ROOT, exists, walkFiles, extractSpecifiers, tryResolveSpecifier, listWorkspacePackages,
  buildExportResolveMap, resolveViaExports
} from './lib.mjs'

const entriesDoc = JSON.parse(fs.readFileSync(auditOutput('entries.json'), 'utf8'))
const packageNameToDir = new Map(Object.entries(entriesDoc.packageNameToDir))
const pkgs = listWorkspacePackages()
const exportMaps = buildExportResolveMap(pkgs)

const SCOPE_ROOTS = ['apps', 'packages', 'plugins', 'scripts']
const allFiles = []
for (const r of SCOPE_ROOTS) {
  // skip apps/mobile
  for (const f of walkFiles(r, { includeTests: true })) {
    if (f.startsWith('apps/mobile/')) continue
    allFiles.push(f)
  }
}

const productionFiles = allFiles.filter(f =>
  !/(^|\/)(tests|__tests__|e2e|fixtures|mocks|__mocks__|stories)(\/|$)/.test(f) &&
  !/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(f) &&
  !f.includes('.test.') &&
  !f.includes('.spec.')
)

console.log(`allFiles=${allFiles.length} productionFiles=${productionFiles.length}`)

const graph = new Map() // file -> Set(resolved deps)
const unresolvedLocal = []

let i = 0
for (const file of allFiles) {
  i++
  if (i % 500 === 0) process.stderr.write(`\rparse ${i}/${allFiles.length}`)
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const specs = extractSpecifiers(src)
  const deps = new Set()
  for (const spec of specs) {
    let resolved = null
    if (spec.startsWith('@action-driver/') || packageNameToDir.has(spec.split('/')[0])) {
      resolved = resolveViaExports(spec, exportMaps)
    }
    if (!resolved) resolved = tryResolveSpecifier(file, spec, packageNameToDir)
    if (resolved) deps.add(resolved)
    else if (spec.startsWith('.') || spec.startsWith('@action-driver/')) {
      unresolvedLocal.push({ from: file, spec })
    }
  }
  // also catch bare dynamic import template hints: import(`...`) — mark file as dynamic-load-risk later via legacy scan
  graph.set(file, deps)
}
process.stderr.write('\n')

// Also link package directory markers: if someone imports package name resolving to dir, expand to index
function expand(file) {
  if (!file) return null
  if (exists(file) && fs.statSync(path.join(ROOT, file)).isFile()) return file
  return null
}

const entrySet = new Set(entriesDoc.entries.filter(e => expand(e)))
// Add plugin extension/catalog sources as entries if present
for (const p of listWorkspacePackages().filter(x => x.kind === 'plugin')) {
  for (const cand of [`${p.dir}/src/extension.ts`, `${p.dir}/src/catalog.ts`, `${p.dir}/src/index.ts`]) {
    if (exists(cand)) entrySet.add(cand)
  }
}

const reachable = new Set()
const queue = [...entrySet]
for (const e of entrySet) reachable.add(e)

while (queue.length) {
  const cur = queue.pop()
  const deps = graph.get(cur)
  if (!deps) continue
  for (const d of deps) {
    const f = expand(d)
    if (!f || reachable.has(f)) continue
    reachable.add(f)
    queue.push(f)
  }
}

// Also: files only reachable from tests
const testEntries = allFiles.filter(f =>
  /\.(test|spec)\.(ts|tsx|mjs|js)$/.test(f) ||
  /(^|\/)(tests|__tests__|e2e)(\/|$)/.test(f)
)
const testReachable = new Set()
const tq = [...testEntries]
for (const e of testEntries) testReachable.add(e)
while (tq.length) {
  const cur = tq.pop()
  const deps = graph.get(cur) || new Set()
  for (const d of deps) {
    const f = expand(d)
    if (!f || testReachable.has(f)) continue
    testReachable.add(f)
    tq.push(f)
  }
}

const onlyTestReachable = productionFiles.filter(f => !reachable.has(f) && testReachable.has(f))
const fullyOrphan = productionFiles.filter(f => !reachable.has(f) && !testReachable.has(f))

// group by module
function moduleOf(f) {
  const parts = f.split('/')
  if (parts[0] === 'scripts') return 'scripts'
  return parts.slice(0, 2).join('/')
}

const byModule = {}
for (const f of fullyOrphan) {
  const m = moduleOf(f)
  ;(byModule[m] ||= []).push(f)
}
const byModuleTestOnly = {}
for (const f of onlyTestReachable) {
  const m = moduleOf(f)
  ;(byModuleTestOnly[m] ||= []).push(f)
}

const out = {
  stats: {
    allFiles: allFiles.length,
    productionFiles: productionFiles.length,
    entries: entrySet.size,
    reachableFromEntries: reachable.size,
    fullyOrphan: fullyOrphan.length,
    onlyTestReachable: onlyTestReachable.length,
    unresolvedLocalSample: unresolvedLocal.slice(0, 50),
    unresolvedLocalCount: unresolvedLocal.length
  },
  fullyOrphan: fullyOrphan.sort(),
  onlyTestReachable: onlyTestReachable.sort(),
  byModule,
  byModuleTestOnly,
  reachableSample: [...reachable].slice(0, 20)
}

fs.writeFileSync(auditOutput('import-graph.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out.stats, null, 2))
