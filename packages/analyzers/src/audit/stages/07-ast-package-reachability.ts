import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
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

const DEFAULT_TARGETS = [
  'packages/computer-use/browser-runtime',
  'packages/computer-use/browser-desktop',
  'packages/computer-use/cua',
  'packages/plugins/plugin-runtime',
  'packages/agent/agent-runtime',
  'packages/ui/adapters/codex',
  'packages/office/onlyoffice-pdf',
  'apps/desktop',
  'apps/local-runtime',
  'plugins/office',
  'plugins/visual-creation',
  'plugins/presentations'
]

export interface AstReachabilityPackageResult {
  dir: string
  fileCount: number
  entryCount: number
  reachable: number
  unreachableCount: number
  unreachable: string[]
  dynamicImports: Array<{ file: string; spec: string; line: number }>
  dynamicImportCount: number
}

export function runAstPackageReachability(
  root: string,
  outDir: string,
  targets: readonly string[] = DEFAULT_TARGETS
): Record<string, AstReachabilityPackageResult> {
  const pkgs = listWorkspacePackages(root)
  const packageNameToDir = new Map(pkgs.map((p) => [p.name, p.dir]))
  const exportMaps = buildExportResolveMap(root, pkgs)
  const entriesDoc = readStageJson<EntriesReport>(outDir, 'entries.json')

  function prodFiles(dir: string) {
    return walkFiles(root, dir, { includeTests: false }).filter(
      (f) =>
        !/\.(test|spec)\./.test(f) &&
        !/(^|\/)(tests|__tests__|e2e|fixtures|mocks)(\/|$)/.test(f) &&
        f.startsWith(dir + '/')
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

  function analyzePackage(dir: string): AstReachabilityPackageResult {
    const files = prodFiles(dir)
    const entries = new Set((entriesDoc.entries || []).filter((e) => e.startsWith(dir + '/')))
    for (const c of [
      `${dir}/src/index.ts`,
      `${dir}/src/extension.ts`,
      `${dir}/src/service.ts`,
      `${dir}/src/catalog.ts`,
      `${dir}/src/main/index.ts`,
      `${dir}/src/preload/index.ts`,
      `${dir}/src/renderer/src/main.tsx`
    ]) {
      if (exists(root, c)) entries.add(c)
    }

    const graph = new Map<string, Set<string>>()
    const dynamicImports: Array<{ file: string; spec: string; line: number }> = []
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
      const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0]
          if (arg && ts.isStringLiteral(arg)) {
            dynamicImports.push({
              file,
              spec: arg.text,
              line: sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1
            })
            const r = resolveSpec(file, arg.text)
            if (r) deps.add(r)
          } else {
            dynamicImports.push({
              file,
              spec: '(non-literal)',
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
            })
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
      graph.set(file, deps)
    }

    const reachable = new Set<string>()
    const q = [...entries]
    for (const e of entries) {
      if (files.includes(e) || exists(root, e)) reachable.add(e)
    }
    while (q.length) {
      const cur = q.pop()!
      for (const d of graph.get(cur) || []) {
        if (!d.startsWith(dir + '/') || reachable.has(d)) continue
        if (!files.includes(d) && !exists(root, d)) continue
        reachable.add(d)
        q.push(d)
      }
    }

    const pkg = pkgs.find((p) => p.dir === dir)
    if (pkg) {
      for (const [k, v] of exportMaps.exact) {
        if ((k === pkg.name || k.startsWith(pkg.name + '/')) && v.startsWith(dir + '/')) {
          if (!reachable.has(v)) {
            reachable.add(v)
            q.push(v)
          }
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
    }

    const unreachable = files.filter((f) => !reachable.has(f)).sort()
    return {
      dir,
      fileCount: files.length,
      entryCount: entries.size,
      reachable: reachable.size,
      unreachableCount: unreachable.length,
      unreachable,
      dynamicImports: dynamicImports.slice(0, 50),
      dynamicImportCount: dynamicImports.length
    }
  }

  const results: Record<string, AstReachabilityPackageResult> = {}
  for (const t of targets) {
    if (!exists(root, t)) continue
    results[t] = analyzePackage(t)
  }
  writeStageJson(outDir, 'ast-reachability.json', results)
  return results
}
