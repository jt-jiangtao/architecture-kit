import fs from 'node:fs'
import path from 'node:path'
import {
  buildExportResolveMap,
  exists,
  extractSpecifiers,
  listWorkspacePackages,
  readStageJson,
  resolveViaExports,
  tryResolveSpecifier,
  walkFiles,
  writeStageJson
} from './lib.js'
import type { EntriesReport } from './01-collect-entries.js'

export interface ImportGraphReport {
  stats: {
    allFiles: number
    productionFiles: number
    entries: number
    reachableFromEntries: number
    fullyOrphan: number
    onlyTestReachable: number
    unresolvedLocalSample: Array<{ from: string; spec: string }>
    unresolvedLocalCount: number
  }
  fullyOrphan: string[]
  onlyTestReachable: string[]
  byModule: Record<string, string[]>
  byModuleTestOnly: Record<string, string[]>
  reachableSample: string[]
}

export function runImportGraph(root: string, outDir: string): ImportGraphReport {
  const entriesDoc = readStageJson<EntriesReport>(outDir, 'entries.json')
  const packageNameToDir = new Map(Object.entries(entriesDoc.packageNameToDir || {}))
  const pkgs = listWorkspacePackages(root)
  const exportMaps = buildExportResolveMap(root, pkgs)

  const allFiles: string[] = []
  for (const r of ['apps', 'packages', 'plugins', 'scripts']) {
    for (const f of walkFiles(root, r, { includeTests: true })) {
      if (f.startsWith('apps/mobile/')) continue
      allFiles.push(f)
    }
  }

  const productionFiles = allFiles.filter(
    (f) =>
      !/(^|\/)(tests|__tests__|e2e|fixtures|mocks|__mocks__|stories)(\/|$)/.test(f) &&
      !/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(f) &&
      !f.includes('.test.') &&
      !f.includes('.spec.')
  )

  const graph = new Map<string, Set<string>>()
  const unresolvedLocal: Array<{ from: string; spec: string }> = []

  for (const file of allFiles) {
    // Intentionally propagate I/O errors so read failures fail the stage instead of emitting partial graphs.
    const src = fs.readFileSync(path.join(root, file), 'utf8')
    const specs = extractSpecifiers(src)
    const deps = new Set<string>()
    for (const spec of specs) {
      let resolved: string | null = null
      if (spec.startsWith('@action-driver/') || packageNameToDir.has(spec.split('/')[0]!)) {
        resolved = resolveViaExports(root, spec, exportMaps)
      }
      if (!resolved) resolved = tryResolveSpecifier(root, file, spec, packageNameToDir)
      if (resolved) deps.add(resolved)
      else if (spec.startsWith('.') || spec.startsWith('@action-driver/')) {
        unresolvedLocal.push({ from: file, spec })
      }
    }
    graph.set(file, deps)
  }

  function expand(file: string | null): string | null {
    if (!file) return null
    if (exists(root, file) && fs.statSync(path.join(root, file)).isFile()) return file
    return null
  }

  const entrySet = new Set(
    (entriesDoc.entries || []).map((e) => expand(e)).filter((e): e is string => Boolean(e))
  )
  for (const p of pkgs.filter((x) => x.kind === 'plugin')) {
    for (const cand of [`${p.dir}/src/extension.ts`, `${p.dir}/src/catalog.ts`, `${p.dir}/src/index.ts`]) {
      if (exists(root, cand)) entrySet.add(cand)
    }
  }

  const reachable = new Set<string>(entrySet)
  const queue = [...entrySet]
  while (queue.length) {
    const cur = queue.pop()!
    const deps = graph.get(cur)
    if (!deps) continue
    for (const d of deps) {
      const f = expand(d)
      if (!f || reachable.has(f)) continue
      reachable.add(f)
      queue.push(f)
    }
  }

  const testEntries = allFiles.filter(
    (f) => /\.(test|spec)\.(ts|tsx|mjs|js)$/.test(f) || /(^|\/)(tests|__tests__|e2e)(\/|$)/.test(f)
  )
  const testReachable = new Set<string>(testEntries)
  const tq = [...testEntries]
  while (tq.length) {
    const cur = tq.pop()!
    const deps = graph.get(cur) || new Set<string>()
    for (const d of deps) {
      const f = expand(d)
      if (!f || testReachable.has(f)) continue
      testReachable.add(f)
      tq.push(f)
    }
  }

  const onlyTestReachable = productionFiles.filter((f) => !reachable.has(f) && testReachable.has(f))
  const fullyOrphan = productionFiles.filter((f) => !reachable.has(f) && !testReachable.has(f))

  const moduleOf = (f: string) => {
    const parts = f.split('/')
    return parts[0] === 'scripts' ? 'scripts' : parts.slice(0, 2).join('/')
  }
  const byModule: Record<string, string[]> = {}
  for (const f of fullyOrphan) {
    const m = moduleOf(f)
    ;(byModule[m] ||= []).push(f)
  }
  const byModuleTestOnly: Record<string, string[]> = {}
  for (const f of onlyTestReachable) {
    const m = moduleOf(f)
    ;(byModuleTestOnly[m] ||= []).push(f)
  }

  const out: ImportGraphReport = {
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
  writeStageJson(outDir, 'import-graph.json', out)
  return out
}
