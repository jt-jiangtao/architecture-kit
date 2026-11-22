import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  buildExportResolveMap,
  exists,
  extractSpecifiers,
  flattenExports,
  listWorkspacePackages,
  readStageJson,
  resolveViaExports,
  tryResolveSpecifier,
  walkFiles,
  writeStageJson
} from './lib.js'
import type { EntriesReport } from './01-collect-entries.js'

export interface PackageAstSummary {
  dir: string
  fileCount: number
  entryCount: number
  reachable: number
  unreachableCount: number
  unreachable: string[]
  dynamicImports: number
}

export function runAstAllPackages(root: string, outDir: string) {
  const pkgs = listWorkspacePackages(root)
  const packageNameToDir = new Map(pkgs.map((p) => [p.name, p.dir]))
  const exportMaps = buildExportResolveMap(root, pkgs)
  const entriesDoc = readStageJson<EntriesReport>(outDir, 'entries.json')

  function prodFiles(dir: string) {
    return walkFiles(root, dir, { includeTests: false }).filter(
      (f) =>
        !/\.(test|spec)\./.test(f) &&
        !/(^|\/)(tests|__tests__|e2e|fixtures|mocks|__mocks__|stories)(\/|$)/.test(f) &&
        (f.includes('/src/') ||
          f.includes('/scripts/') ||
          f.includes('/skills/') ||
          f.includes('/resources/') ||
          f.includes('/ui/') ||
          f.includes('/server/') ||
          f.includes('/case-library/') ||
          /\/[^/]+\.(mjs|ts|tsx)$/.test(f))
    )
  }

  function resolveSpec(from: string, spec: string): string | null {
    let r: string | null = null
    if (spec.startsWith('@action-driver/') || packageNameToDir.has(spec.split('/')[0]!)) {
      r = resolveViaExports(root, spec, exportMaps)
    }
    if (!r) r = tryResolveSpecifier(root, from, spec, packageNameToDir)
    return r
  }

  function analyze(dir: string): PackageAstSummary | null {
    const files = prodFiles(dir)
    if (files.length === 0) return null
    const entries = new Set((entriesDoc.entries || []).filter((e) => e.startsWith(dir + '/')))
    for (const c of [
      `${dir}/src/index.ts`,
      `${dir}/src/extension.ts`,
      `${dir}/src/service.ts`,
      `${dir}/src/catalog.ts`,
      `${dir}/src/main/index.ts`,
      `${dir}/src/preload/index.ts`,
      `${dir}/src/renderer/src/main.tsx`,
      `${dir}/src/cli.ts`,
      `${dir}/src/server.ts`,
      `${dir}/src/composition.ts`,
      `${dir}/src/composition-root.ts`,
      `${dir}/src/node-entry.ts`,
      `${dir}/src/runtime-entry.ts`,
      `${dir}/src/host-entry.mjs`
    ]) {
      if (exists(root, c)) entries.add(c)
    }

    const pkg = pkgs.find((p) => p.dir === dir)
    if (pkg) {
      for (const e of flattenExports(root, pkg.pkg.exports, pkg.dir)) {
        if (e.resolved && exists(root, e.resolved) && !String(e.resolved).includes('*')) {
          entries.add(e.resolved)
        }
      }
    }

    const graph = new Map<string, Set<string>>()
    let dyn = 0
    for (const file of files) {
      let src: string
      try {
        src = fs.readFileSync(path.join(root, file), 'utf8')
      } catch {
        continue
      }
      const deps = new Set<string>()
      for (const spec of extractSpecifiers(src)) {
        const r = resolveSpec(file, spec)
        if (r) deps.add(r)
      }
      try {
        const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            dyn++
            const arg = node.arguments[0]
            if (arg && ts.isStringLiteral(arg)) {
              const r = resolveSpec(file, arg.text.replace(/\?.*$/, ''))
              if (r) deps.add(r)
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(sf)
      } catch {
        // ignore syntax edge cases
      }
      graph.set(file, deps)
    }

    const reachable = new Set<string>()
    const q: string[] = []
    for (const e of entries) {
      if (exists(root, e)) {
        reachable.add(e)
        q.push(e)
      }
    }
    while (q.length) {
      const cur = q.pop()!
      for (const d of graph.get(cur) || []) {
        if (!d.startsWith(dir + '/') || reachable.has(d)) continue
        reachable.add(d)
        q.push(d)
      }
    }

    const unreachable = files.filter((f) => !reachable.has(f)).sort()
    return {
      dir,
      fileCount: files.length,
      entryCount: [...entries].filter((e) => exists(root, e)).length,
      reachable: [...reachable].filter((f) => f.startsWith(dir + '/')).length,
      unreachableCount: unreachable.length,
      unreachable,
      dynamicImports: dyn
    }
  }

  const results: Record<string, PackageAstSummary> = {}
  for (const p of pkgs) {
    const r = analyze(p.dir)
    if (r) results[p.dir] = r
  }
  const summary = Object.entries(results)
    .map(([dir, r]) => ({
      dir,
      files: r.fileCount,
      unreachable: r.unreachableCount,
      dyn: r.dynamicImports
    }))
    .sort((a, b) => b.unreachable - a.unreachable)

  const out = { results, summary }
  writeStageJson(outDir, 'ast-all-packages.json', out)
  return out
}
